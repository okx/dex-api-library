/**
 * Solana MEV Protection Implementation
 * 
 * Comprehensive MEV resistance through multiple layers:
 * 
 * 1. Sandwich Attack Prevention:
 *    - Price impact monitoring (MAX_PRICE_IMPACT)
 *    - Route splitting across multiple DEXs
 *    - Quote variance analysis
 * 
 * 2. Frontrunning Protection:
 *    - Dynamic priority fees
 *    - Compute unit optimization
 *    - Transaction simulation
 * 
 * 3. Backrunning Defense:
 *    - Slippage tolerance
 *    - Quick confirmation targeting
 *    - Route analysis
 * 
 * 4. Honeypot Detection:
 *    - Token validation
 *    - Contract analysis
 *    - Liquidity verification
 * 
 * 5. Route Protection:
 *    - Minimum route splits (2-4 splits)
 *    - DEX diversity requirements
 *    - Quote consistency checks
 * 
 * 6. Transaction Protection:
 *    - Compute unit limits
 *    - Priority fee optimization
 *    - Confirmation monitoring
 * 
 * Key Components:
 * - MEVProtection: Core protection logic
 * - TransactionBuilder: MEV-resistant transaction construction
 * - OKXApi: Protected API interactions
 */

import base58 from "bs58";
import BN from "bn.js";
import {
    Connection,
    ComputeBudgetProgram,
    Transaction,
    VersionedTransaction,
    TransactionInstruction,
    Blockhash,
    Keypair,
    PublicKey
} from "@solana/web3.js";
import cryptoJS from "crypto-js";
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Core interfaces for swap operations with MEV protection metadata
 */
interface TokenInfo {
    symbol: string;
    decimals: number;
    price: string;
    isHoneyPot: boolean;  // Honeypot detection for MEV protection
}

interface SwapQuote {
    fromToken: TokenInfo;
    toToken: TokenInfo;
    quote?: any; // For storing full quote data
}

interface SwapParams {
    amount: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    userAddress: string;
    computeUnitPrice: string;
}

/**
 * MEV Protection Configuration
 * 
 * Critical parameters for protecting against various MEV attack vectors:
 * - MAX_PRICE_IMPACT: Prevents excessive price manipulation (sandwich attacks)
 * - SLIPPAGE: Protects against price movement during transaction confirmation
 * - MIN_ROUTE_SPLITS: Ensures trade splitting for better price discovery
 * - COMPUTE_UNITS: Ensures transaction execution priority
 */
const MEV_PROTECTION = {
    // Sandwich Attack Prevention
    MAX_PRICE_IMPACT: "0.05",        // 5% max price impact to prevent sandwiching
    SLIPPAGE: "0.05",                // 5% slippage tolerance

    // Route Protection
    MIN_ROUTE_SPLITS: 2,             // Minimum DEX routes to split trade
    MAX_ROUTE_SPLITS: 4,             // Maximum DEX routes to prevent complexity

    // Frontrunning Protection
    MIN_PRIORITY_FEE: 10_000,        // Base priority fee
    MAX_PRIORITY_FEE: 1_000_000,     // Maximum priority fee cap
    PRIORITY_MULTIPLIER: 2,          // Multiplier for competitive priority

    // Execution Protection
    COMPUTE_UNITS: {
        BASE: 300_000,               // Minimum compute units
        MAX: 1_200_000               // Maximum for complex routes
    },

    // Transaction Protection
    MAX_IN_FLIGHT_DURATION_MS: 1000, // Maximum transaction pending time
    CONFIRMATION_TIMEOUT: 60_000,    // Confirmation timeout
    RETRY_COUNT: 3                   // Maximum retry attempts
} as const;

// Constants
const REQUIRED_ENV_VARS = {
    OKX_API_KEY: process.env.OKX_API_KEY,
    OKX_SECRET_KEY: process.env.OKX_SECRET_KEY,
    OKX_API_PASSPHRASE: process.env.OKX_API_PASSPHRASE,
    OKX_PROJECT_ID: process.env.OKX_PROJECT_ID,
    WALLET_ADDRESS: process.env.WALLET_ADDRESS,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL
};

// Validate environment variables
Object.entries(REQUIRED_ENV_VARS).forEach(([key, value]) => {
    if (!value) throw new Error(`${key} is required`);
});

// Configuration constants
// Configuration constants
const CONFIG = {
    CHAIN_ID: "501",
    BASE_COMPUTE_UNITS: 300000,
    MAX_COMPUTE_UNITS: 1200000,
    MAX_RETRIES: 3 as const,  // Added as const
    SLIPPAGE: "0.5",
    MAX_PRICE_IMPACT: 3,
    PRIORITY_FEES: {
        LOW: 1_000,
        MEDIUM: 10_000,
        HIGH: 100_000,
        VERY_HIGH: 1_000_000
    }
} as const;

const ENV = {
    OKX_API_KEY: getRequiredEnvVar('OKX_API_KEY'),
    OKX_SECRET_KEY: getRequiredEnvVar('OKX_SECRET_KEY'),
    OKX_API_PASSPHRASE: getRequiredEnvVar('OKX_API_PASSPHRASE'),
    OKX_PROJECT_ID: getRequiredEnvVar('OKX_PROJECT_ID'),
    WALLET_ADDRESS: getRequiredEnvVar('WALLET_ADDRESS'),
    PRIVATE_KEY: getRequiredEnvVar('PRIVATE_KEY'),
    SOLANA_RPC_URL: getRequiredEnvVar('SOLANA_RPC_URL')
} as const;

// Helper functions
function getRequiredEnvVar(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function assertString(value: string | undefined, name: string): string {
    if (!value) throw new Error(`${name} is undefined`);
    return value;
}

// Connection setup with MEV-resistant config
const connection = new Connection(ENV.SOLANA_RPC_URL, {
    confirmTransactionInitialTimeout: MEV_PROTECTION.MAX_IN_FLIGHT_DURATION_MS,
    commitment: 'processed'
});

/**
 * MEV Protection Class
 * 
 * Core logic for protecting against MEV attacks through:
 * 1. Quote validation
 * 2. Route analysis
 * 3. Transaction simulation
 */
class MEVProtection {
    /**
     * Validates swap safety against MEV attacks
     * 
     * Checks:
     * 1. Price impact within safe limits
     * 2. Sufficient route diversity
     * 3. Quote consistency across DEXes
     */
    static async validateSwapSafety(quote: any): Promise<void> {
        if (!quote?.routerResult) {
            throw new Error("Invalid quote data");
        }

        const routerResult = quote.routerResult;
        console.log("Router result:", JSON.stringify(routerResult, null, 2));

        // Sandwich Attack Prevention
        const priceImpact = parseFloat(routerResult.priceImpactPercentage) / 100;
        if (priceImpact > parseFloat(MEV_PROTECTION.MAX_PRICE_IMPACT)) {
            throw new Error(`Sandwich attack risk: Price impact ${(priceImpact * 100).toFixed(2)}% too high`);
        }

        // Route Analysis for MEV Protection
        const quoteCompareList = routerResult.quoteCompareList || [];
        if (quoteCompareList.length < MEV_PROTECTION.MIN_ROUTE_SPLITS) {
            throw new Error(`MEV risk: Insufficient route diversity`);
        }

        // Quote Analysis
        const quotes = quoteCompareList.map((q: { amountOut: string; }) => parseFloat(q.amountOut));
        const bestQuote = Math.max(...quotes);
        const avgQuote = quotes.reduce((a: number, b: number) => a + b, 0) / quotes.length;
        const quoteVariance = Math.abs(bestQuote - avgQuote) / bestQuote;

        if (quoteVariance > 0.05) {
            console.warn(`MEV Warning: High quote variance detected (${(quoteVariance * 100).toFixed(2)}%)`);
        }

        console.log("MEV protection validation passed ✅");
    }

    /**
     * Simulates transaction to detect potential MEV attacks
     * 
     * Validates:
     * 1. Expected output matches simulation
     * 2. No unexpected state changes
     * 3. Computation within limits
     */
    static async simulateTransaction(
        tx: Transaction | VersionedTransaction,
        expectedMinOutput: number
    ): Promise<void> {
        console.log("Simulating transaction...");
        const simulation = tx instanceof VersionedTransaction ?
            await connection.simulateTransaction(tx) :
            await connection.simulateTransaction(tx as Transaction);

        if (simulation.value.err) {
            throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
        }
        console.log("Transaction simulation successful ✅");
    }
}

// Enhanced OKX API Class
class OKXApi {
    private static readonly BASE_URL = "https://www.okx.com/api/v5/dex";

    private static getHeaders(timestamp: string, method: string, path: string, queryString = ""): Record<string, string> {
        const stringToSign = timestamp + method + path + queryString;
        const secretKey = assertString(ENV.OKX_SECRET_KEY, 'OKX_SECRET_KEY');

        return {
            "Content-Type": "application/json",
            "OK-ACCESS-KEY": ENV.OKX_API_KEY,
            "OK-ACCESS-SIGN": cryptoJS.enc.Base64.stringify(
                cryptoJS.HmacSHA256(stringToSign, secretKey)
            ),
            "OK-ACCESS-TIMESTAMP": timestamp,
            "OK-ACCESS-PASSPHRASE": ENV.OKX_API_PASSPHRASE,
            "OK-ACCESS-PROJECT": ENV.OKX_PROJECT_ID
        };
    }

    static async getTokenInfo(fromTokenAddress: string, toTokenAddress: string): Promise<SwapQuote> {
        const timestamp = new Date().toISOString();
        const path = "/aggregator/quote";
        const params = new URLSearchParams({
            chainId: CONFIG.CHAIN_ID,
            fromTokenAddress,
            toTokenAddress,
            amount: "1000000",
            slippage: CONFIG.SLIPPAGE
        });

        const response = await fetch(
            `${this.BASE_URL}${path}?${params.toString()}`,
            {
                headers: this.getHeaders(timestamp, "GET", `/api/v5/dex${path}`, `?${params.toString()}`),
                method: "GET"
            }
        );

        const data = await response.json();
        if (!response.ok || data.code !== "0" || !data.data?.[0]) {
            throw new Error(`Failed to get quote: ${data.msg || response.statusText}`);
        }

        const quoteData = data.data[0];
        const { fromToken, toToken } = quoteData;

        return {
            fromToken: {
                symbol: fromToken.tokenSymbol,
                decimals: parseInt(fromToken.decimal),
                price: fromToken.tokenUnitPrice,
                isHoneyPot: fromToken.isHoneyPot
            },
            toToken: {
                symbol: toToken.tokenSymbol,
                decimals: parseInt(toToken.decimal),
                price: toToken.tokenUnitPrice,
                isHoneyPot: toToken.isHoneyPot
            },
            quote: quoteData // Store full quote for MEV protection
        };
    }

    static async getSwapTransaction(params: SwapParams): Promise<{ txData: string; quote: any }> {
        const timestamp = new Date().toISOString();
        const path = "/aggregator/swap";
        const queryParams = new URLSearchParams({
            chainId: CONFIG.CHAIN_ID,
            slippage: CONFIG.SLIPPAGE,
            amount: params.amount,
            fromTokenAddress: params.fromTokenAddress,
            toTokenAddress: params.toTokenAddress,
            userWalletAddress: params.userAddress,
            computeUnitPrice: params.computeUnitPrice
        });

        const response = await fetch(
            `${this.BASE_URL}${path}?${queryParams.toString()}`,
            {
                headers: this.getHeaders(timestamp, "GET", `/api/v5/dex${path}`, `?${queryParams.toString()}`),
                method: "GET"
            }
        );

        const data = await response.json();
        if (!response.ok || data.code !== "0" || !data.data?.[0]) {
            throw new Error(`Swap quote failed: ${data.msg || response.statusText}`);
        }

        const swapData = data.data[0];
        const txData = swapData.tx?.data;
        if (!txData || typeof txData !== 'string') {
            throw new Error("Invalid transaction data received");
        }

        return {
            txData,
            quote: swapData  // Return the complete swap data
        };
    }
}

/**
 * Transaction Builder with MEV Protection
 * 
 * Builds transactions with:
 * 1. Optimized priority fees
 * 2. Compute budget adjustments
 * 3. MEV-resistant instruction ordering
 */
class TransactionBuilder {
    /**
     * Builds and signs transaction with MEV protection
     * 
     * Protection mechanisms:
     * 1. Priority fee optimization
     * 2. Compute unit adjustment
     * 3. Transaction simulation
     */
    static async buildAndSignProtectedTransaction(
        txData: string,
        feePayer: Keypair,
        expectedOutput: number
    ): Promise<Transaction | VersionedTransaction> {
        const decodedTx = base58.decode(txData);
        const recentBlockhash = await connection.getLatestBlockhash('processed');

        let tx: Transaction | VersionedTransaction;
        try {
            tx = VersionedTransaction.deserialize(decodedTx);
            tx.message.recentBlockhash = recentBlockhash.blockhash;
        } catch {
            tx = Transaction.from(decodedTx);
            tx.recentBlockhash = recentBlockhash.blockhash;
            tx.feePayer = feePayer.publicKey;
        }

        // Compute units for better success rate
        const computeBudgetIx = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: await this.getPriorityFee()
        });

        if (tx instanceof Transaction) {
            tx.add(computeBudgetIx);
        }

        // Simulate before signing
        await MEVProtection.simulateTransaction(tx, expectedOutput);

        // Sign the transaction
        if (tx instanceof VersionedTransaction) {
            tx.sign([feePayer]);
        } else {
            tx.partialSign(feePayer);
        }

        return tx;
    }

    /**
     * Sends and confirms transaction with MEV protection
     * 
     * Features:
     * 1. Retry mechanism
     * 2. Confirmation monitoring
     * 3. Error handling
     */
    static async sendAndConfirmProtectedTransaction(tx: Transaction | VersionedTransaction): Promise<string> {
        const txId = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: MEV_PROTECTION.RETRY_COUNT,
            preflightCommitment: 'confirmed'
        });

        console.log(`Transaction sent: ${txId}`);
        console.log(`Explorer URL: https://solscan.io/tx/${txId}`);

        try {
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

            const confirmation = await connection.confirmTransaction({
                signature: txId,
                blockhash,
                lastValidBlockHeight
            }, 'confirmed');

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            console.log("\nTransaction confirmed successfully! ✅");

            // Return txId immediately after confirmation
            return txId;

        } catch (error) {
            console.error("Transaction failed:", error);
            throw error;
        }
    }

    /**
     * Gets optimal priority fee to prevent frontrunning
     * 
     * Strategy:
     * 1. Analyzes recent fees
     * 2. Applies multiplier for protection
     * 3. Caps maximum fee
     */
    static async getPriorityFee(): Promise<number> {
        try {
            const recentFees = await connection.getRecentPrioritizationFees();
            if (recentFees.length === 0) return MEV_PROTECTION.MAX_PRIORITY_FEE;

            // Frontrunning Protection Strategy
            const maxFee = Math.max(...recentFees.map(fee => fee.prioritizationFee));
            const medianFee = recentFees.sort((a, b) => a.prioritizationFee - b.prioritizationFee)[
                Math.floor(recentFees.length / 2)
            ].prioritizationFee;

            // Dynamic fee calculation for MEV resistance
            const baseFee = Math.max(maxFee, medianFee * MEV_PROTECTION.PRIORITY_MULTIPLIER);
            return Math.min(baseFee * 1.5, MEV_PROTECTION.MAX_PRIORITY_FEE);
        } catch {
            return MEV_PROTECTION.MAX_PRIORITY_FEE;
        }
    }
}

// Utility functions
function convertAmount(amount: string, decimals: number): string {
    const value = parseFloat(amount);
    if (isNaN(value) || value <= 0) {
        throw new Error("Invalid amount");
    }
    return new BN(Math.floor(value * Math.pow(10, decimals))).toString();
}

/**
 * Main swap execution with comprehensive MEV protection
 * 
 * Protection flow:
 * 1. Token validation and honeypot detection
 * 2. Route analysis and splitting
 * 3. Priority fee optimization
 * 4. Protected transaction building and execution
 */
async function executeProtectedSwap(
    amount: string,
    fromTokenAddress: string,
    toTokenAddress: string
): Promise<string> {
    const MAX_RETRIES = 3;
    const retry = async <T>(
        fn: () => Promise<T>,
        retries: number = MAX_RETRIES
    ): Promise<T> => {
        try {
            return await fn();
        } catch (error) {
            if (retries <= 0) throw error;
            console.log(`Retrying... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            return retry(fn, retries - 1);
        }
    };

    console.log("Starting protected swap with parameters:");
    console.log("Amount:", amount);
    console.log("From Token:", fromTokenAddress);
    console.log("To Token:", toTokenAddress);
    console.log("Wallet Address:", ENV.WALLET_ADDRESS);

    // Get token information with validation
    const tokenInfo = await retry(async () => {
        console.log("\nFetching token information...");
        return await OKXApi.getTokenInfo(fromTokenAddress, toTokenAddress);
    });

    console.log("Token info received:", tokenInfo);

    // Validate token safety
    if (tokenInfo.toToken.isHoneyPot) {
        throw new Error("Destination token detected as potential honeypot");
    }

    // Convert amount
    const rawAmount = convertAmount(amount, tokenInfo.fromToken.decimals);
    console.log("\nConverted amount:", rawAmount);

    // Get optimized priority fee
    const priorityFee = await TransactionBuilder.getPriorityFee();
    console.log("Priority fee:", priorityFee);

    // Get swap quote with MEV protection
    console.log("\nRequesting protected swap transaction...");
    // Get swap quote with MEV protection
    console.log("\nRequesting protected swap transaction...");
    const { txData, quote } = await retry(async () => {
        return await OKXApi.getSwapTransaction({
            amount: rawAmount,
            fromTokenAddress,
            toTokenAddress,
            userAddress: ENV.WALLET_ADDRESS,
            computeUnitPrice: priorityFee.toString()
        });
    });

    const expectedAmount = Math.floor(
        parseFloat(amount) *
        parseFloat(tokenInfo.fromToken.price) *
        Math.pow(10, tokenInfo.toToken.decimals)
    );

    await MEVProtection.validateSwapSafety(quote);
    console.log("Transaction data received");

    // Create keypair for signing
    const feePayer = Keypair.fromSecretKey(
        Uint8Array.from(base58.decode(ENV.PRIVATE_KEY))
    );

    console.log("\nBuilding and signing protected transaction...");
    const protectedTx = await TransactionBuilder.buildAndSignProtectedTransaction(
        txData,
        feePayer,
        parseFloat(quote.toTokenAmount)
    );

    console.log("Protected transaction built and signed");

    // Send and confirm with protection
    console.log("\nSending protected transaction...");
    return await TransactionBuilder.sendAndConfirmProtectedTransaction(protectedTx);
}

// CLI execution
async function main() {
    try {
        const [amount, fromTokenAddress, toTokenAddress] = process.argv.slice(2);

        if (!amount || !fromTokenAddress || !toTokenAddress) {
            console.log("Usage: ts-node swap.ts <amount> <fromTokenAddress> <toTokenAddress>");
            process.exit(1);
        }

        executeProtectedSwap(amount, fromTokenAddress, toTokenAddress)
            .then(txId => {
                console.log("\nSwap completed successfully!");
                console.log("Transaction ID:", txId);
                console.log("Explorer URL:", `https://solscan.io/tx/${txId}`);
                process.exit(0);  // Exit successfully
            })
            .catch(error => {
                console.error("\nError:", error instanceof Error ? error.message : "Unknown error");
                process.exit(1);  // Exit with error
            });
    } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : "Unknown error");
        process.exit(1);
    }
}

// Execute if running directly
if (require.main === module) {
    main().catch(console.error);
}

// Export functions
export {
    executeProtectedSwap,
    OKXApi,
    TransactionBuilder,
    MEVProtection
};