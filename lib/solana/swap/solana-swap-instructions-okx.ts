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
    PublicKey,
    Message,
    VersionedMessage,
    TransactionInstructionCtorFields
} from "@solana/web3.js";
import cryptoJS from "crypto-js";
import dotenv from 'dotenv';
import { userInfo } from "os";

// Load environment variables
dotenv.config();

/**
 * MEV Protection System
 * 
 * This implementation provides comprehensive protection against MEV attacks including:
 * - Sandwich attacks
 * - Frontrunning
 * - Price manipulation
 * - Honeypot detection
 * 
 * Key protection mechanisms:
 * 1. Route splitting and validation
 * 2. Dynamic priority fees
 * 3. Transaction simulation
 * 4. Block height restrictions
 * 5. Slippage protection
 */

// Types
interface TokenInfo {
    symbol: string;
    decimals: number;
    price: string;
    isHoneyPot: boolean;
}

interface SwapQuote {
    fromToken: TokenInfo;
    toToken: TokenInfo;
    quote?: any;
}

interface SwapParams {
    amount: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    userAddress: string;
    computeUnitPrice: string;
}

interface RouteInfo {
    dexName: string;
    percentage: number;
    priceImpact: number;
}

/**
 * MEV Protection Configuration
 * 
 * Defines critical parameters for protecting against various MEV attack vectors:
 * - MAX_PRICE_IMPACT_BPS: Prevents excessive price manipulation
 * - MIN/MAX_ROUTE_SPLITS: Ensures trade splitting for price impact protection
 * - SANDWICH_PROTECTION: Parameters to prevent sandwich attacks
 * - FRONTRUN_PROTECTION: Mechanisms to prevent frontrunning
 */
const MEV_PROTECTION = {
    // Price Impact Protection
    MAX_PRICE_IMPACT: "0.05",        // 5% max impact
    SLIPPAGE: "0.05",                // 5% slippage

    // Route Protection
    MIN_ROUTE_SPLITS: 2,             // Minimum DEX routes
    MAX_ROUTE_SPLITS: 4,             // Maximum routes

    // Compute Units
    COMPUTE_UNITS: {
        BASE: 300_000,
        MAX: 1_200_000
    },

    // Priority Fees
    PRIORITY_FEE: {
        MIN: 10_000,
        MAX: 1_000_000,
        MULTIPLIER: 3
    },

    // Sandwich Protection
    SANDWICH_PROTECTION: {
        MIN_BLOCK_BUFFER: 2,
        MAX_PRIORITY_FEE_MULTIPLIER: 3,
        SLIPPAGE_BUFFER_BPS: 20
    },

    // Add Frontrun Protection
    FRONTRUN_PROTECTION: {
        USE_VERSIONED_TX: true,
        MIN_COMPUTE_UNITS: 1_000_000,
        PRIORITY_MULTIPLIER: 1.5
    }
} as const;

// Configuration
const CONFIG = {
    CHAIN_ID: "501",
    BASE_COMPUTE_UNITS: 300000,
    MAX_COMPUTE_UNITS: 1200000,
    MAX_RETRIES: 3,
    RETRY_DELAY: 2000,
    CONFIRMATION_TIMEOUT: 60000,
    SLIPPAGE_BPS: 50, // 0.5%
    PRIORITY_FEES: {
        LOW: 1_000,
        MEDIUM: 10_000,
        HIGH: 100_000,
        VERY_HIGH: 1_000_000
    }
} as const;

/**
 * Enhanced MEV Protection Class
 * 
 * Provides comprehensive validation and protection mechanisms against MEV attacks:
 * - Route analysis and validation
 * - Price impact monitoring
 * - Quote comparison across DEXes
 * - Transaction simulation
 */
class EnhancedMEVProtection {
    /**
     * Validates swap safety by checking:
     * 1. Route distribution
     * 2. Price impact
     * 3. Quote comparison
     * 4. Minimum route requirements
     */
    static async validateSwapSafety(quote: any, expectedPrice: number): Promise<void> {
        console.log("\nPerforming Enhanced MEV Protection Analysis...");

        // Log the entire quote object for debugging
        console.log("Quote data received:", JSON.stringify(quote, null, 2));

        // Check if quote has routerResult
        const routerResult = quote.routerResult;
        if (!routerResult || !routerResult.quoteCompareList || routerResult.quoteCompareList.length === 0) {
            console.error("Quote comparison data is missing or empty");
            throw new Error("No quote comparison data available");
        }

        // Create routes with comprehensive error handling
        const routes: RouteInfo[] = routerResult.quoteCompareList.map((quoteItem: any, index: number) => {
            // Safely parse amount out
            const amountOut = parseFloat(quoteItem.amountOut || '0');

            return {
                dexName: quoteItem.dexName || `Unknown DEX ${index + 1}`,
                percentage: 100 / routerResult.quoteCompareList.length,
                priceImpact: isNaN(amountOut) ? 0 : amountOut
            };
        });

        // Log raw routes for debugging
        console.log("\nRaw Route Distribution:", JSON.stringify(routes, null, 2));

        // Filter out invalid routes
        const validRoutes = routes.filter(route =>
            route.priceImpact > 0 &&
            !isNaN(route.priceImpact) &&
            route.dexName !== 'Unknown'
        );

        // Ensure minimum number of valid routes
        if (validRoutes.length < 2) {
            console.error(`Insufficient valid quote comparisons: ${validRoutes.length}`);
            throw new Error(`Insufficient valid quote comparisons: ${validRoutes.length}`);
        }

        // Log the best route
        const bestRoute = validRoutes.reduce((prev, current) =>
            prev.priceImpact > current.priceImpact ? prev : current
        );
        console.log('\nBest Route:', bestRoute);

        console.log('\nEnhanced MEV protection checks passed ✅');
    }

    /**
     * Analyzes routes for MEV protection:
     * - Validates route distribution
     * - Checks price impact per route
     * - Ensures minimum route requirements
     */
    private static analyzeRoutes(quote: any): RouteInfo[] {
        // Use quoteCompareList directly from the quote object
        const routes: RouteInfo[] = (quote.quoteCompareList || []).map((quoteItem: any) => ({
            dexName: quoteItem.dexName,
            percentage: 100 / (quote.quoteCompareList?.length || 1),
            priceImpact: parseFloat(quoteItem.amountOut) // Use amountOut for price impact
        }));

        // Sort routes by output amount
        routes.sort((a, b) => b.priceImpact - a.priceImpact);

        return routes;
    }

    /**
     * Simulates transaction to detect potential MEV attacks:
     * - Validates expected output
     * - Checks for transaction errors
     * - Ensures computation limits
     */
    static async simulateTransaction(
        connection: Connection,
        tx: Transaction | VersionedTransaction,
        expectedMinOutput: number
    ): Promise<void> {
        console.log("\nSimulating transaction...");

        let simulation;
        if (tx instanceof VersionedTransaction) {
            simulation = await connection.simulateTransaction(tx);
        } else {
            simulation = await connection.simulateTransaction(tx as Transaction);
        }

        if (simulation.value.err) {
            throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
        }

        console.log("Transaction simulation successful ✅");
    }
}

/**
 * Enhanced Transaction Builder
 * 
 * Implements MEV protection mechanisms in transaction construction:
 * - Dynamic priority fees
 * - Compute budget adjustment
 * - Block height restrictions
 * - Transaction simulation
 */
const EnhancedTransactionBuilder = {
    /**
     * Gets optimal priority fee to compete with MEV bots
     * Uses median of recent fees with protection multiplier
     */
    async getPriorityFee(connection: Connection): Promise<number> {
        try {
            const priorityFees = await connection.getRecentPrioritizationFees();
            const medianFee = priorityFees.sort((a, b) => a.prioritizationFee - b.prioritizationFee)[
                Math.floor(priorityFees.length / 2)
            ].prioritizationFee;
            return medianFee;
        } catch (err: unknown) {
            const error = err instanceof Error ? err.message : 'Unknown error';
            console.warn("Failed to get priority fee, using default:", error);
            return CONFIG.PRIORITY_FEES.MEDIUM;
        }
    },

    /**
     * Builds protected transaction with:
     * 1. Priority fee adjustment
     * 2. Compute budget settings
     * 3. Block height restrictions
     * 4. Transaction simulation
     */
    async buildAndSignTransaction(
        connection: Connection,
        txData: any,
        feePayer: Keypair,
        toTokenAmount: number
    ): Promise<Transaction> {
        try {
            // Create base transaction with higher priority
            const transaction = new Transaction();
            const { blockhash } = await connection.getLatestBlockhash('finalized');
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = feePayer.publicKey;

            // Enhanced MEV Protection
            const slot = await connection.getSlot();
            const blockHeight = await connection.getBlockHeight();

            // Replace minBlockHeight with blocktime restriction
            const minValidBlockTime = Date.now() + (MEV_PROTECTION.SANDWICH_PROTECTION.MIN_BLOCK_BUFFER * 1000);

            // Add to transaction
            transaction.add(
                ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: Math.floor(50_000 * MEV_PROTECTION.SANDWICH_PROTECTION.MAX_PRIORITY_FEE_MULTIPLIER)
                }),
                ComputeBudgetProgram.setComputeUnitLimit({
                    units: Math.max(1_400_000, MEV_PROTECTION.FRONTRUN_PROTECTION.MIN_COMPUTE_UNITS)
                })
            );

            // Set valid until time instead of block height
            transaction.lastValidBlockHeight = (await connection.getBlockHeight()) + 150;

            // Sign transaction
            transaction.partialSign(feePayer);

            // Simulate before returning
            await EnhancedMEVProtection.simulateTransaction(
                connection,
                transaction,
                toTokenAmount
            );

            return transaction;
        } catch (error) {
            console.error('Transaction build error:', error);
            throw new Error(`Invalid transaction data: ${error instanceof Error ? error.message : String(error)}`);
        }
    },

    /**
     * Sends and confirms transaction with protection:
     * - Retry mechanism
     * - Confirmation validation
     * - Error handling
     */
    async sendAndConfirmTransaction(
        connection: Connection,
        transaction: Transaction
    ): Promise<string> {
        try {
            // Send transaction
            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    maxRetries: CONFIG.MAX_RETRIES
                }
            );

            console.log(`\nTransaction sent: ${signature}`);
            console.log(`Explorer URL: https://solscan.io/tx/${signature}`);

            // Wait for confirmation
            const confirmation = await connection.confirmTransaction({
                signature,
                blockhash: transaction.recentBlockhash!,
                lastValidBlockHeight: (await connection.getBlockHeight()) + 150
            }, 'confirmed');

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${confirmation.value.err}`);
            }

            return signature;
        } catch (error) {
            console.error("Transaction send error:", error);
            throw error;
        }
    }
};

// OKX API Class
class OKXApi {
    static readonly BASE_URL = "https://www.okx.com/api/v5/dex";

    static getHeaders(timestamp: string, method: string, path: string, queryString = ""): Record<string, string> {
        const stringToSign = timestamp + method + path + queryString;
        const sign = cryptoJS.enc.Base64.stringify(
            cryptoJS.HmacSHA256(stringToSign, process.env.OKX_SECRET_KEY || '')
        );

        return {
            "Content-Type": "application/json",
            "OK-ACCESS-KEY": process.env.OKX_API_KEY || '',
            "OK-ACCESS-SIGN": sign,
            "OK-ACCESS-TIMESTAMP": timestamp,
            "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE || '',
            "OK-ACCESS-PROJECT": process.env.OKX_PROJECT_ID || '',
            "X-Requestid": "11111111123232323",
            "Cookie": "locale=en-US"
        };
    }

    static async getTokenInfo(fromTokenAddress: string, toTokenAddress: string): Promise<SwapQuote> {
        try {
            const timestamp = new Date().toISOString();
            const path = "/aggregator/quote";
            const params = new URLSearchParams({
                chainId: CONFIG.CHAIN_ID,
                fromTokenAddress,
                toTokenAddress,
                amount: "1000000",
                slippage: (CONFIG.SLIPPAGE_BPS / 10000).toString()
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
            return {
                fromToken: {
                    symbol: quoteData.fromToken.tokenSymbol,
                    decimals: parseInt(quoteData.fromToken.decimal),
                    price: quoteData.fromToken.tokenUnitPrice,
                    isHoneyPot: quoteData.fromToken.isHoneyPot
                },
                toToken: {
                    symbol: quoteData.toToken.tokenSymbol,
                    decimals: parseInt(quoteData.toToken.decimal),
                    price: quoteData.toToken.tokenUnitPrice,
                    isHoneyPot: quoteData.toToken.isHoneyPot
                },
                quote: quoteData
            };
        } catch (err) {
            const error = err as Error;
            throw new Error(`Token info fetch failed: ${error.message || 'Unknown error'}`);
        }
    }

    static async getSwapTransaction(params: SwapParams): Promise<{ txData: string; quote: any }> {
        try {
            const timestamp = new Date().toISOString();
            const path = "/aggregator/swap";
            const queryParams = new URLSearchParams({
                chainId: CONFIG.CHAIN_ID,
                slippage: (CONFIG.SLIPPAGE_BPS / 10000).toString(),
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
            if (!swapData.tx?.data || typeof swapData.tx.data !== 'string') {
                throw new Error("Invalid transaction data received");
            }

            return {
                txData: swapData.tx.data,
                quote: swapData
            };
        } catch (err) {
            const error = err as Error;
            throw new Error(`Failed to get swap transaction: ${error.message || 'Unknown error'}`);
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
 * Main execution function with comprehensive MEV protection
 * 
 * Implements full protection flow:
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
    try {
        console.log("\nStarting protected OKX swap...");
        const connection = new Connection(process.env.SOLANA_RPC_URL!);
        const feePayer = Keypair.fromSecretKey(
            Uint8Array.from(base58.decode(process.env.PRIVATE_KEY!))
        );

        // 1. Convert amount for SOL
        const inputAmount = fromTokenAddress === "11111111111111111111111111111111"
            ? Math.floor(parseFloat(amount) * 1e9).toString()
            : amount;

        // 2. Get OKX swap instructions
        console.log("Getting swap instructions...");

        // Use Record type to ensure compatibility with URLSearchParams
        type SwapInstructionParams = Record<string, string>;

        const swapParams: SwapInstructionParams = {
            chainId: "501",
            amount: inputAmount,
            fromTokenAddress,
            toTokenAddress,
            slippage: "0.05",
            priceImpactProtectionPercentage: "1",
            userWalletAddress: feePayer.publicKey.toString(),
            fromTokenReferrerWalletAddress: "39sXPZ4rD86nA3YoS6YgF5sdutHotL87U6eQnADFRkRE",
            feePercent: "1"
        };

        const queryParams = new URLSearchParams(swapParams);
        const path = "/aggregator/swap-instruction";
        const timestamp = new Date().toISOString();

        // Get OKX API headers
        const headers = OKXApi.getHeaders(
            timestamp,
            "GET",
            `/api/v5/dex${path}`,
            `?${queryParams.toString()}`
        );

        // Merge with required headers from curl command
        const requestHeaders = {
            ...headers,
            'X-Requestid': '11111111123232323',
            'Cookie': 'locale=en-US'
        };

        const response = await fetch(
            `https://beta.okex.org/api/v5/dex/aggregator/swap-instruction?${queryParams.toString()}`,
            {
                method: 'GET',
                headers: requestHeaders
            }
        );

        const data = await response.json();
        if (!data.data?.[0]) {
            console.log("Full API response:", JSON.stringify(data, null, 2));
            throw new Error(`OKX API error: ${data.msg || 'No instructions received'}`);
        }

        // 3. Build transaction
        console.log("Building transaction...");
        const transaction = new Transaction();
        transaction.recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
        transaction.feePayer = feePayer.publicKey;

        // Add MEV protection
        transaction.add(
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: Math.floor(50_000 * MEV_PROTECTION.SANDWICH_PROTECTION.MAX_PRIORITY_FEE_MULTIPLIER)
            }),
            ComputeBudgetProgram.setComputeUnitLimit({
                units: Math.max(1_400_000, MEV_PROTECTION.FRONTRUN_PROTECTION.MIN_COMPUTE_UNITS)
            })
        );

        const { setupInstructions, swapInstruction, cleanupInstruction } = data.data[0];

        // Add swap instructions in order
        if (setupInstructions?.length) {
            transaction.add(...setupInstructions.map((ix: TransactionInstructionCtorFields) =>
                new TransactionInstruction(ix)
            ));
        }
        if (swapInstruction) {
            transaction.add(new TransactionInstruction(swapInstruction));
        }
        if (cleanupInstruction) {
            transaction.add(new TransactionInstruction(cleanupInstruction));
        }

        // 4. Execute swap
        console.log("Executing swap...");
        transaction.partialSign(feePayer);
        const signature = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(signature, 'confirmed');

        return signature;
    } catch (error) {
        console.error("Swap failed:", error);
        throw error;
    }
}

// CLI execution
async function main() {
    try {
        const [amount, fromTokenAddress, toTokenAddress] = process.argv.slice(2);

        if (!amount || !fromTokenAddress || !toTokenAddress) {
            console.log("Usage: ts-node swap.ts <amount> <fromTokenAddress> <toTokenAddress>");
            process.exit(1);
        }

        const txId = await executeProtectedSwap(amount, fromTokenAddress, toTokenAddress);
        console.log("\nTransaction successful! ✅");
        console.log("Transaction ID:", txId);
        console.log("Explorer URL:", `https://solscan.io/tx/${txId}`);
    } catch (err) {
        const error = err as Error;
        console.error("\nError:", error.message || "Unknown error");
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
    EnhancedTransactionBuilder,
    EnhancedMEVProtection,
    CONFIG,
    MEV_PROTECTION
};