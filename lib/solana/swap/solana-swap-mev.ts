/**
 * MEV-Resistant Solana Swap Implementation with OKX DEX Integration
 */

import base58 from "bs58";
import BN from "bn.js";
import {
    Connection,
    ComputeBudgetProgram,
    Transaction,
    VersionedTransaction,
    MessageV0 as VersionedMessage,
    Keypair,
    PublicKey
} from "@solana/web3.js";
import cryptoJS from "crypto-js";
import dotenv from 'dotenv';
import { getHeaders } from "../../shared";

// Load environment variables
dotenv.config();

// =================
// Types & Interfaces 
// =================

interface TokenInfo {
    symbol: string;
    decimals: number;
    price: string;
    isHoneyPot?: boolean;
}

interface SwapQuote {
    fromToken: TokenInfo;
    toToken: TokenInfo;
    quote?: any;
}

interface SwapParams {
    chainId: string;
    amount: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    slippage: string;
    priceImpactProtectionPercentage: string;
    userWalletAddress: string;
}

interface TradeChunk {
    amount: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    minAmountOut: string;
}

// =================
// Configuration
// =================

const MEV_PROTECTION = {
    // Trade Protection
    MAX_PRICE_IMPACT: "0.05",        // 5% max price impact
    SLIPPAGE: "0.05",                // 5% slippage tolerance
    MIN_ROUTES: 2,                   // Minimum DEX routes

    // Priority Fees
    MIN_PRIORITY_FEE: 10_000,
    MAX_PRIORITY_FEE: 1_000_000,
    PRIORITY_MULTIPLIER: 2,

    // TWAP Settings
    TWAP_ENABLED: true,
    TWAP_INTERVALS: 4,               // Split into 4 parts
    TWAP_DELAY_MS: 2000,            // 2s between trades

    // Transaction Settings
    COMPUTE_UNITS: 300_000,
    MAX_RETRIES: 3,
    CONFIRMATION_TIMEOUT: 60_000,

    // Block Targeting
    TARGET_SPECIFIC_BLOCKS: true,
    PREFERRED_SLOT_OFFSET: 2,        // Target blocks with slot % 4 == 2
} as const;

const CONFIG = {
    CHAIN_ID: "501",                 // Solana mainnet
    BASE_COMPUTE_UNITS: 300000,
    MAX_RETRIES: 3,
    SLIPPAGE: "0.5"
} as const;

// Environment validation
function getRequiredEnvVar(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

const ENV = {
    OKX_API_KEY: getRequiredEnvVar('OKX_API_KEY'),
    OKX_SECRET_KEY: getRequiredEnvVar('OKX_SECRET_KEY'),
    OKX_API_PASSPHRASE: getRequiredEnvVar('OKX_API_PASSPHRASE'),
    OKX_PROJECT_ID: getRequiredEnvVar('OKX_PROJECT_ID'),
    WALLET_ADDRESS: getRequiredEnvVar('WALLET_ADDRESS'),
    PRIVATE_KEY: getRequiredEnvVar('PRIVATE_KEY'),
    RPC_URL: getRequiredEnvVar('SOLANA_RPC_URL')
} as const;

// =================
// RPC Management
// =================

const connection = new Connection(ENV.RPC_URL, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: MEV_PROTECTION.CONFIRMATION_TIMEOUT
});

// =================
// OKX API Integration
// =================

class OKXApi {
    private static readonly BASE_URL = "https://www.okx.com";

    static async getQuote(params: any) {
        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/aggregator/quote";
        const queryString = "?" + new URLSearchParams(params).toString();

        console.log('Requesting quote with params:', params);

        const headers = {
            ...getHeaders(timestamp, "GET", requestPath, queryString),
            'Cookie': 'locale=en-US'
        };

        const response = await fetch(`${this.BASE_URL}${requestPath}${queryString}`, {
            method: "GET",
            headers
        });

        const data = await response.json();
        console.log('Quote response:', JSON.stringify(data, null, 2));

        if (!response.ok || data.code !== "0") {
            throw new Error(`Failed to get quote: ${data.msg || response.statusText}`);
        }

        if (!data.data?.[0]) {
            throw new Error(`No quote data available: ${JSON.stringify(data)}`);
        }

        return data.data[0];
    }

    static async getSwapTransaction(params: any): Promise<any> {
        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/aggregator/swap";  // Changed from swap-instruction to swap
        const queryString = "?" + new URLSearchParams(params).toString();

        console.log('Requesting swap transaction with params:', params);

        const headers = {
            ...getHeaders(timestamp, "GET", requestPath, queryString),
            'Cookie': 'locale=en-US'
        };

        const response = await fetch(`${this.BASE_URL}${requestPath}${queryString}`, {
            method: "GET",
            headers
        });

        const data = await response.json();
        console.log('Swap transaction response:', JSON.stringify(data, null, 2));

        if (!response.ok || data.code !== "0") {
            throw new Error(`Failed to get swap transaction: ${data.msg || response.statusText}`);
        }

        if (!data.data?.[0]) {
            throw new Error(`No swap transaction data available: ${JSON.stringify(data)}`);
        }

        return data.data[0];
    }
}

// =================
// TWAP Implementation
// =================

class TWAPExecution {
    static async splitTrade(
        totalAmount: string,
        fromTokenAddress: string,
        toTokenAddress: string
    ): Promise<TradeChunk[]> {
        const amount = new BN(totalAmount);
        const chunkSize = amount.divn(MEV_PROTECTION.TWAP_INTERVALS);

        return Array(MEV_PROTECTION.TWAP_INTERVALS)
            .fill(null)
            .map(() => ({
                amount: chunkSize.toString(),
                fromTokenAddress,
                toTokenAddress,
                minAmountOut: "0" // Will be calculated per chunk
            }));
    }

    static async executeTWAP(chunks: TradeChunk[]): Promise<string[]> {
        const txIds: string[] = [];

        for (const chunk of chunks) {
            // Wait for preferred block if enabled
            if (MEV_PROTECTION.TARGET_SPECIFIC_BLOCKS) {
                await BlockTargeting.waitForPreferredBlock();
            }

            // Execute chunk
            const txId = await executeSwapChunk(chunk);
            txIds.push(txId);

            // Random delay between chunks
            const randomDelay = MEV_PROTECTION.TWAP_DELAY_MS * (0.8 + Math.random() * 0.4);
            await new Promise(resolve => setTimeout(resolve, randomDelay));
        }

        return txIds;
    }
}

// =================
// Block Targeting
// =================

class BlockTargeting {
    static async waitForPreferredBlock(): Promise<void> {
        while (true) {
            const slot = await connection.getSlot();
            if (slot % 4 === MEV_PROTECTION.PREFERRED_SLOT_OFFSET) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }
}

// =================
// Transaction Building
// =================
class TransactionBuilder {
    static async buildAndSignTransaction(
        txData: string,
        feePayer: Keypair,
        priorityFee: number
    ): Promise<VersionedTransaction> {
        try {
            // OKX provides base58 encoded transaction data
            const decodedTx = base58.decode(txData);
            console.log("Decoded transaction length:", decodedTx.length);

            // Create versioned transaction directly
            const versionedTx = VersionedTransaction.deserialize(decodedTx);
            console.log("Successfully decoded versioned transaction");

            // Get latest blockhash
            const { blockhash } = await connection.getLatestBlockhash('finalized');

            // Check if transaction already contains a compute unit price instruction
            const existingPriorityFeeIx = versionedTx.message.compiledInstructions.find(ix =>
                versionedTx.message.staticAccountKeys[ix.programIdIndex].equals(ComputeBudgetProgram.programId) &&
                ix.data[0] === 3  // ComputeUnitPrice instruction discriminator
            );

            let newInstructions = [...versionedTx.message.compiledInstructions];
            let newStaticAccountKeys = [...versionedTx.message.staticAccountKeys];

            // Only add priority fee if it doesn't exist
            if (!existingPriorityFeeIx) {
                // Create priority fee instruction
                const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: priorityFee
                });

                // Get or add program ID
                let priorityFeeProgramIndex = newStaticAccountKeys.findIndex(
                    key => key.equals(ComputeBudgetProgram.programId)
                );

                if (priorityFeeProgramIndex === -1) {
                    priorityFeeProgramIndex = newStaticAccountKeys.length;
                    newStaticAccountKeys.push(ComputeBudgetProgram.programId);
                }

                // Add priority fee instruction
                const compiledPriorityFeeIx = {
                    programIdIndex: priorityFeeProgramIndex,
                    accountKeyIndexes: [],
                    data: priorityFeeIx.data
                };

                newInstructions = [compiledPriorityFeeIx, ...newInstructions];
            } else {
                console.log("Transaction already contains priority fee instruction");
            }

            // Create new versioned message
            const newMessage = new VersionedMessage({
                header: versionedTx.message.header,
                staticAccountKeys: newStaticAccountKeys,
                recentBlockhash: blockhash,
                compiledInstructions: newInstructions,
                addressTableLookups: versionedTx.message.addressTableLookups
            });

            // Create and sign new transaction
            const newTx = new VersionedTransaction(newMessage);
            newTx.sign([feePayer]);

            return newTx;

        } catch (error) {
            console.error("Error building versioned transaction:", error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            throw new Error(`Failed to process transaction data: ${errorMessage}`);
        }
    }

    static async getPriorityFee(): Promise<number> {
        try {
            const recentFees = await connection.getRecentPrioritizationFees();
            if (recentFees.length === 0) return MEV_PROTECTION.MAX_PRIORITY_FEE;

            const maxFee = Math.max(...recentFees.map(fee => fee.prioritizationFee));
            const medianFee = recentFees.sort((a, b) => a.prioritizationFee - b.prioritizationFee)[
                Math.floor(recentFees.length / 2)
            ].prioritizationFee;

            const baseFee = Math.max(maxFee, medianFee * MEV_PROTECTION.PRIORITY_MULTIPLIER);
            return Math.min(baseFee * 1.5, MEV_PROTECTION.MAX_PRIORITY_FEE);
        } catch {
            return MEV_PROTECTION.MAX_PRIORITY_FEE;
        }
    }
}

// =================
// Swap Execution
// =================

async function executeSwapChunk(chunk: TradeChunk): Promise<string> {
    // Get optimal priority fee
    const priorityFee = await TransactionBuilder.getPriorityFee();
    console.log("Using priority fee:", priorityFee);

    // First get swap quote
    const swapParams = {
        chainId: CONFIG.CHAIN_ID,
        amount: chunk.amount,
        fromTokenAddress: chunk.fromTokenAddress,
        toTokenAddress: chunk.toTokenAddress,
        slippage: CONFIG.SLIPPAGE,
        priceImpactProtectionPercentage: MEV_PROTECTION.MAX_PRICE_IMPACT,
        userWalletAddress: ENV.WALLET_ADDRESS
    };

    console.log('Requesting swap with params:', swapParams);

    // Get swap transaction
    const swapData = await OKXApi.getSwapTransaction(swapParams);
    console.log("Got swap transaction data");

    // Log additional transaction data details for debugging
    if (swapData.tx?.data) {
        console.log("Transaction data length:", swapData.tx.data.length);
        console.log("Transaction data starts with:", swapData.tx.data.slice(0, 50));
    }

    if (!swapData.tx?.data) {
        throw new Error("No transaction data received from OKX");
    }

    // Build and sign transaction
    const feePayer = Keypair.fromSecretKey(
        Uint8Array.from(base58.decode(ENV.PRIVATE_KEY))
    );

    const tx = await TransactionBuilder.buildAndSignTransaction(
        swapData.tx.data,
        feePayer,
        priorityFee
    );

    console.log("Successfully built transaction");

    // Send transaction with simulation first
    const txId = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'processed',
        maxRetries: MEV_PROTECTION.MAX_RETRIES
    });

    console.log(`Transaction sent: ${txId}`);
    console.log(`Explorer URL: https://solscan.io/tx/${txId}`);

    // Get latest blockhash for confirmation
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

    // Wait for confirmation
    const confirmation = await connection.confirmTransaction({
        signature: txId,
        blockhash,
        lastValidBlockHeight
    }, 'confirmed');

    if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    return txId;
}

// =================
// Main Entry Point
// =================

async function executeMEVResistantSwap(
    amount: string,
    fromTokenAddress: string,
    toTokenAddress: string
): Promise<string[]> {
    console.log("Starting MEV-resistant swap with parameters:");
    console.log("Amount:", amount);
    console.log("From Token:", fromTokenAddress);
    console.log("To Token:", toTokenAddress);

    // Get quote to validate tokens
    const quoteParams = {
        chainId: CONFIG.CHAIN_ID,
        fromTokenAddress,
        toTokenAddress,
        amount: "1000000", // Use a small amount for initial quote
        slippage: CONFIG.SLIPPAGE
    };

    console.log("Getting initial quote to validate tokens...");
    const quoteData = await OKXApi.getQuote(quoteParams);

    if (quoteData.toToken.isHoneyPot) {
        throw new Error("Destination token detected as potential honeypot");
    }

    // Convert amount to proper decimals
    const rawAmount = new BN(
        Math.floor(parseFloat(amount) * Math.pow(10, parseInt(quoteData.fromToken.decimal)))
    ).toString();

    console.log("Amount in base units:", rawAmount);

    // Execute as TWAP if enabled
    if (MEV_PROTECTION.TWAP_ENABLED) {
        console.log("TWAP enabled, splitting trade into chunks...");
        const chunks = await TWAPExecution.splitTrade(
            rawAmount,
            fromTokenAddress,
            toTokenAddress
        );
        return await TWAPExecution.executeTWAP(chunks);
    }

    // Otherwise execute as single transaction
    const txId = await executeSwapChunk({
        amount: rawAmount,
        fromTokenAddress,
        toTokenAddress,
        minAmountOut: "0"
    });

    return [txId];
}

// =================
// CLI Execution
// =================

async function main() {
    try {
        const [amount, fromTokenAddress, toTokenAddress] = process.argv.slice(2);

        if (!amount || !fromTokenAddress || !toTokenAddress) {
            console.log("Usage: ts-node swap.ts <amount> <fromTokenAddress> <toTokenAddress>");
            console.log("Example: ts-node swap.ts 1.5 11111111111111111111111111111111 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
            process.exit(1);
        }

        const txIds = await executeMEVResistantSwap(
            amount,
            fromTokenAddress,
            toTokenAddress
        );

        console.log("\nSwap completed successfully!");
        console.log("Transaction IDs:", txIds.join(", "));
        console.log("Explorer URLs:");
        txIds.forEach(txId => {
            console.log(`https://solscan.io/tx/${txId}`);
        });
        process.exit(0);

    } catch (error) {
        console.error("\nError:", error instanceof Error ? error.message : "Unknown error");
        process.exit(1);
    }
}

// Execute if running directly
if (require.main === module) {
    main().catch(console.error);
}

// Export key functionality
export {
    executeMEVResistantSwap,
    OKXApi,
    TransactionBuilder,
    TWAPExecution,
    BlockTargeting
};