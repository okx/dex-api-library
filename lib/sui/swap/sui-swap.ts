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

interface SwapParams {
    chainId: string;
    amount: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    userWalletAddress: string;
    slippage: string;
}

// Constants
const TOKENS = {
    SUI: "0x2::sui::SUI",
    USDC: "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN"
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

// Generate OKX API headers
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

    const params: SwapParams = {
        chainId: CONFIG.CHAIN_ID,
        amount,
        fromTokenAddress: fromToken,
        toTokenAddress: toToken,
        userWalletAddress: process.env.WALLET_ADDRESS,
        slippage: CONFIG.SLIPPAGE
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

    const data = await response.json();
    if (data.code !== '0' || !data.data?.[0]) {
        console.error('API Response:', data);
        throw new Error(`API Error: ${data.msg || 'Unknown error'}`);
    }

    return data.data[0];
}

async function executeTransaction(txData: string, privateKey: string): Promise<TransactionResult> {
    let retryCount = 0;

    // Create keypair from private key
    const keypair = Ed25519Keypair.fromSecretKey(fromHex(privateKey));
    const sender = keypair.getPublicKey().toSuiAddress();

    while (retryCount < CONFIG.MAX_RETRIES) {
        try {
            // Create new transaction block
            const tx = new Transaction();

            // Deserialize the transaction data from OKX
            const deserializedTx = Transaction.from(txData);

            // Copy all transactions from the deserialized block to our new block
            for (const transaction of deserializedTx.blockData.transactions) {
                tx.blockData.transactions.push(transaction);
            }

            // Set sender
            tx.setSender(sender);

            // Get reference gas price from network
            const referenceGasPrice = await client.getReferenceGasPrice();
            const gasPrice = BigInt(referenceGasPrice) > CONFIG.MIN_GAS_PRICE
                ? BigInt(referenceGasPrice)
                : CONFIG.MIN_GAS_PRICE;

            // Set gas parameters
            tx.setGasPrice(gasPrice);
            tx.setGasBudget(CONFIG.DEFAULT_GAS_BUDGET_MIST);

            // Build and sign transaction
            const builtTx = await tx.build({ client });
            const { signature, bytes } = await tx.sign({ client, signer: keypair });

            // Execute transaction
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

            // Exponential backoff
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

        // Execute swap (amount in MIST - smallest SUI unit)
        await swap(
            '10000000',     // 0.01 SUI
            TOKENS.SUI,     // From SUI
            TOKENS.USDC     // To USDC
        );
    } catch (error) {
        console.error('Swap failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}