import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex } from '@mysten/bcs';
import { HmacSHA256 } from 'crypto-js';
import { enc } from 'crypto-js';
import * as dotenv from 'dotenv';

dotenv.config();

// Interfaces
interface TransactionResult {
    txId: string;
    confirmation: any;
}

interface SwapQuoteResponse {
    code: string;
    data: [{
        tx: {
            data: string;
            gas?: string;
        };
        routerResult: {
            toTokenAmount: string;
            fromTokenAmount: string;
        };
    }];
    msg?: string;
}

// Constants - Using your existing constants
const TOKENS = {
    SUI: "0x2::sui::SUI",
    USDC: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"
} as const;

const CONFIG = {
    MAX_RETRIES: 8,
    BASE_URL: 'https://www.okx.com',
    CHAIN_ID: '784',
    SLIPPAGE: '0.01',
    DEFAULT_GAS_BUDGET_MIST: 50000000n, // 0.05 SUI
    MIN_GAS_PRICE: 1000n
} as const;

// Initialize Sui client
const client = new SuiClient({
    url: getFullnodeUrl('mainnet')
});

function getHeaders(timestamp: string, method: string, path: string, query: string = ''): Record<string, string> {
    const stringToSign = timestamp + method + path + query;

    return {
        'Content-Type': 'application/json',
        'OK-ACCESS-KEY': process.env.OKX_API_KEY!,
        'OK-ACCESS-SIGN': enc.Base64.stringify(
            HmacSHA256(stringToSign, process.env.OKX_SECRET_KEY!)
        ),
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': process.env.OKX_API_PASSPHRASE!,
        'OK-ACCESS-PROJECT': process.env.OKX_PROJECT_ID!
    };
}

async function getSwapQuote(amount: string, fromToken: string, toToken: string) {
    if (!process.env.WALLET_ADDRESS) {
        throw new Error('WALLET_ADDRESS is required');
    }

    const params = {
        chainId: CONFIG.CHAIN_ID,
        amount: amount,
        fromTokenAddress: fromToken,
        toTokenAddress: toToken,
        userWalletAddress: process.env.WALLET_ADDRESS,
        slippage: CONFIG.SLIPPAGE,
        autoSlippage: "true",
        maxAutoSlippageBps: "100"
    };

    const timestamp = new Date().toISOString();
    const path = '/api/v5/dex/aggregator/swap';
    const query = '?' + new URLSearchParams(
        Object.entries(params).map(([key, value]) => [key, value.toString()])
    ).toString();

    const response = await fetch(`${CONFIG.BASE_URL}${path}${query}`, {
        method: 'GET',
        headers: getHeaders(timestamp, 'GET', path, query)
    });

    const data: SwapQuoteResponse = await response.json();
    if (data.code !== '0' || !data.data?.[0]) {
        console.error('API Response:', data);
        throw new Error(`API Error: ${data.msg || 'Unknown error'}`);
    }

    return data.data[0];
}

async function executeTransaction(txData: string, privateKey: string): Promise<TransactionResult> {
    let retryCount = 0;
    const keypair = Ed25519Keypair.fromSecretKey(fromHex(privateKey));
    const sender = keypair.getPublicKey().toSuiAddress();

    while (retryCount < CONFIG.MAX_RETRIES) {
        try {
            // Deserialize transaction block from OKX data
            const txBlock = Transaction.from(txData);

            // Set sender and gas parameters
            txBlock.setSender(sender);
            const referenceGasPrice = await client.getReferenceGasPrice();
            const gasPrice = BigInt(referenceGasPrice) > CONFIG.MIN_GAS_PRICE
                ? BigInt(referenceGasPrice)
                : CONFIG.MIN_GAS_PRICE;

            txBlock.setGasPrice(gasPrice);
            txBlock.setGasBudget(CONFIG.DEFAULT_GAS_BUDGET_MIST);

            // Sign and execute transaction
            const { bytes, signature } = await txBlock.sign({ client, signer: keypair });

            const result = await client.executeTransactionBlock({
                transactionBlock: bytes,
                signature,
                options: {
                    showEffects: true,
                    showEvents: true,
                }
            });

            if (!result.digest) {
                throw new Error('Transaction failed: No digest received');
            }

            // Wait for finality
            const confirmation = await client.waitForTransaction({
                digest: result.digest,
                options: {
                    showEffects: true,
                    showEvents: true,
                }
            });

            // Verify transaction success
            const status = confirmation.effects?.status?.status;
            if (status !== 'success') {
                throw new Error(`Transaction failed with status: ${status}`);
            }

            return {
                txId: result.digest,
                confirmation
            };

        } catch (error) {
            console.error(`Attempt ${retryCount + 1} failed:`, error);
            retryCount++;

            if (retryCount === CONFIG.MAX_RETRIES) {
                throw error;
            }

            await new Promise(resolve => setTimeout(resolve, 2000 * Math.pow(2, retryCount)));
        }
    }

    throw new Error('Max retries exceeded');
}

async function swap(amount: string, fromToken: string, toToken: string): Promise<string> {
    console.log(`Starting swap: ${amount} ${fromToken} → ${toToken}`);

    const quote = await getSwapQuote(amount, fromToken, toToken);
    console.log(`Got quote: ${quote.routerResult.toTokenAmount} output tokens`);

    const result = await executeTransaction(quote.tx.data, process.env.PRIVATE_KEY!);
    console.log(`Swap successful! 🎉`);
    console.log(`Transaction: https://suiscan.xyz/mainnet/tx/${result.txId}`);
    return result.txId;
}

// Helper function to convert SUI to MIST
function suiToMist(amount: number): string {
    return (BigInt(Math.floor(amount * 1e9))).toString();
}

async function main() {
    try {
        // Required environment variables check
        const required = [
            'PRIVATE_KEY',
            'WALLET_ADDRESS',
            'OKX_API_KEY',
            'OKX_SECRET_KEY',
            'OKX_API_PASSPHRASE',
            'OKX_PROJECT_ID'
        ];

        for (const env of required) {
            if (!process.env[env]) throw new Error(`Missing ${env}`);
        }

        // Example: Swap 0.01 SUI to USDC
        const amountInSui = 0.1;
        const amountInMist = suiToMist(amountInSui);

        await swap(
            amountInMist,
            TOKENS.SUI,
            TOKENS.USDC
        );
    } catch (error) {
        console.error('Swap failed:', error);
        process.exit(1);
    }
}

// Export for module usage
export { swap, suiToMist, TOKENS };

// Run if called directly
if (require.main === module) {
    main().catch(console.error);
}