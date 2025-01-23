import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex } from '@mysten/bcs';
import dotenv from 'dotenv';
import { getHeaders } from '../../shared';

dotenv.config();

// Environment variables check right at the start
const userAddress = process.env.WALLET_ADDRESS;
const userPrivateKey = process.env.PRIVATE_KEY;

// Constants
const TOKENS = {
    SUI: "0x2::sui::SUI",
    USDC: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"
} as const;

const CONFIG = {
    MAX_RETRIES: 3,
    BASE_URL: 'https://www.okx.com',
    CHAIN_ID: '784',
    SLIPPAGE: '0.5',
    DEFAULT_GAS_BUDGET_MIST: 50000000n,
    MIN_GAS_PRICE: 1000n
} as const;

// Initialize Sui client
const client = new SuiClient({
    url: getFullnodeUrl('mainnet')
});

// Interfaces
interface TokenInfo {
    symbol: string;
    decimals: number;
    price: string;
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
        fromToken: {
            tokenSymbol: string;
            decimal: string;
            tokenUnitPrice: string;
        };
        toToken: {
            tokenSymbol: string;
            decimal: string;
            tokenUnitPrice: string;
        };
        priceImpactPercentage?: string;
    }];
    msg?: string;
}

async function getTokenInfo(fromTokenAddress: string, toTokenAddress: string) {
    const timestamp = new Date().toISOString();
    const requestPath = "/api/v5/dex/aggregator/quote";
    const params = {
        chainId: CONFIG.CHAIN_ID,
        fromTokenAddress,
        toTokenAddress,
        amount: "1000000",
        slippage: CONFIG.SLIPPAGE,
    };

    const queryString = "?" + new URLSearchParams(params).toString();
    const headers = getHeaders(timestamp, "GET", requestPath, queryString);

    const response = await fetch(
        `${CONFIG.BASE_URL}${requestPath}${queryString}`,
        { method: "GET", headers }
    );

    const data: SwapQuoteResponse = await response.json();
    if (data.code !== "0" || !data.data?.[0]) {
        throw new Error("Failed to get token information");
    }

    const quoteData = data.data[0];
    return {
        fromToken: {
            symbol: quoteData.fromToken.tokenSymbol,
            decimals: parseInt(quoteData.fromToken.decimal),
            price: quoteData.fromToken.tokenUnitPrice
        },
        toToken: {
            symbol: quoteData.toToken.tokenSymbol,
            decimals: parseInt(quoteData.toToken.decimal),
            price: quoteData.toToken.tokenUnitPrice
        }
    };
}

function convertAmount(amount: string, decimals: number): string {
    try {
        if (!amount || isNaN(parseFloat(amount))) {
            throw new Error("Invalid amount");
        }
        const value = parseFloat(amount);
        if (value <= 0) {
            throw new Error("Amount must be greater than 0");
        }
        return (BigInt(Math.floor(value * Math.pow(10, decimals)))).toString();
    } catch (err) {
        console.error("Amount conversion error:", err);
        throw new Error("Invalid amount format");
    }
}

async function executeTransaction(txData: string, privateKey: string) {
    let retryCount = 0;
    const keypair = Ed25519Keypair.fromSecretKey(fromHex(privateKey));
    const sender = keypair.getPublicKey().toSuiAddress();

    while (retryCount < CONFIG.MAX_RETRIES) {
        try {
            const txBlock = Transaction.from(txData);

            txBlock.setSender(sender);
            const referenceGasPrice = await client.getReferenceGasPrice();
            const gasPrice = BigInt(referenceGasPrice) > CONFIG.MIN_GAS_PRICE
                ? BigInt(referenceGasPrice)
                : CONFIG.MIN_GAS_PRICE;

            txBlock.setGasPrice(gasPrice);
            txBlock.setGasBudget(CONFIG.DEFAULT_GAS_BUDGET_MIST);

            console.log("Signing transaction...");
            const { bytes, signature } = await txBlock.sign({ client, signer: keypair });

            console.log("Executing transaction...");
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

            console.log("Waiting for confirmation...");
            const confirmation = await client.waitForTransaction({
                digest: result.digest,
                options: {
                    showEffects: true,
                    showEvents: true,
                }
            });

            const status = confirmation.effects?.status?.status;
            if (status !== 'success') {
                throw new Error(`Transaction failed with status: ${status}`);
            }

            return { txId: result.digest, confirmation };

        } catch (error) {
            console.error(`Attempt ${retryCount + 1} failed:`, error);
            retryCount++;

            if (retryCount === CONFIG.MAX_RETRIES) {
                throw error;
            }

            await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
        }
    }

    throw new Error('Max retries exceeded');
}

async function main() {
    try {
        const args = process.argv.slice(2);
        if (args.length < 3) {
            console.log("Usage: ts-node sui-swap.ts <amount> <fromTokenAddress> <toTokenAddress>");
            console.log("Example: ts-node sui-swap.ts 1.5 0x2::sui::SUI 0xdba...::usdc::USDC");
            process.exit(1);
        }

        const [amount, fromTokenAddress, toTokenAddress] = args;

        if (!userPrivateKey || !userAddress) {
            throw new Error("Private key or user address not found");
        }

        // Get token information
        console.log("Getting token information...");
        const tokenInfo = await getTokenInfo(fromTokenAddress, toTokenAddress);
        console.log(`From: ${tokenInfo.fromToken.symbol} (${tokenInfo.fromToken.decimals} decimals)`);
        console.log(`To: ${tokenInfo.toToken.symbol} (${tokenInfo.toToken.decimals} decimals)`);

        // Convert amount using fetched decimals
        const rawAmount = convertAmount(amount, tokenInfo.fromToken.decimals);
        console.log(`Amount in ${tokenInfo.fromToken.symbol} base units:`, rawAmount);

        // Get swap quote
        const params = {
            chainId: CONFIG.CHAIN_ID,
            amount: rawAmount,
            fromTokenAddress,
            toTokenAddress,
            userWalletAddress: userAddress,
            slippage: CONFIG.SLIPPAGE,
            autoSlippage: "true",
            maxAutoSlippageBps: "100"
        };

        const timestamp = new Date().toISOString();
        const path = '/api/v5/dex/aggregator/swap';
        const query = '?' + new URLSearchParams(
            Object.entries(params).map(([key, value]) => [key, value.toString()])
        ).toString();

        console.log("Requesting swap quote...");
        const response = await fetch(`${CONFIG.BASE_URL}${path}${query}`, {
            method: 'GET',
            headers: getHeaders(timestamp, 'GET', path, query)
        });

        const data: SwapQuoteResponse = await response.json();
        if (data.code !== '0' || !data.data?.[0]) {
            throw new Error(`API Error: ${data.msg || 'Unknown error'}`);
        }

        const swapData = data.data[0];

        // Show estimated output and price impact
        const outputAmount = parseFloat(swapData.routerResult.toTokenAmount) / Math.pow(10, tokenInfo.toToken.decimals);
        console.log("\nSwap Quote:");
        console.log(`Input: ${amount} ${tokenInfo.fromToken.symbol} ($${(parseFloat(amount) * parseFloat(tokenInfo.fromToken.price)).toFixed(2)})`);
        console.log(`Output: ${outputAmount.toFixed(tokenInfo.toToken.decimals)} ${tokenInfo.toToken.symbol} ($${(outputAmount * parseFloat(tokenInfo.toToken.price)).toFixed(2)})`);
        if (swapData.priceImpactPercentage) {
            console.log(`Price Impact: ${swapData.priceImpactPercentage}%`);
        }

        // Execute the swap
        console.log("\nExecuting swap transaction...");
        const result = await executeTransaction(swapData.tx.data, userPrivateKey);

        console.log("\nSwap completed successfully!");
        console.log("Transaction ID:", result.txId);
        console.log("Explorer URL:", `https://suiscan.xyz/mainnet/tx/${result.txId}`);

        process.exit(0);
    } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : "Unknown error");
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}