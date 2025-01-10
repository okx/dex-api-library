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
    quote?: any; // For storing full quote data
}

interface SwapParams {
    amount: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    userAddress: string;
    computeUnitPrice: string;
}

// MEV Protection Constants
const MEV_PROTECTION = {
    MAX_PRICE_IMPACT_BPS: 150, // 1.5%
    MIN_ROUTE_SPLITS: 2,
    MAX_ROUTE_SPLITS: 4,
    MAX_IN_FLIGHT_DURATION_MS: 1000,
    SIMULATION_ADDRESSES: {
        USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        WSOL: 'So11111111111111111111111111111111111111112',
    }
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

// MEV Protection Class
class MEVProtection {
    static async validateSwapSafety(
        quote: any,
        expectedPrice: number
    ): Promise<void> {
        console.log("Validating quote safety...");

        // Extract routerResult if it exists
        const routerResult = quote.routerResult || quote;
        console.log("Router result:", JSON.stringify(routerResult, null, 2));

        // Check price impact
        const priceImpact = parseFloat(routerResult.priceImpactPercentage || '0') * 100;
        if (priceImpact > MEV_PROTECTION.MAX_PRICE_IMPACT_BPS) {
            throw new Error(`Price impact too high: ${priceImpact} bps`);
        }

        // Check if there are quotes to compare
        const quoteCompareList = routerResult.quoteCompareList || [];
        console.log("Quote comparisons found:", quoteCompareList.length);

        if (quoteCompareList.length === 0) {
            throw new Error('No quotes available for comparison');
        }

        // Analyze quotes
        const quotes = quoteCompareList.map((q: { amountOut: string; }) => parseFloat(q.amountOut));
        console.log("Available quotes:", quotes);

        const bestQuote = Math.max(...quotes);
        const avgQuote = quotes.reduce((a: any, b: any) => a + b, 0) / quotes.length;

        // Check quote competitiveness
        const quoteVariance = Math.abs(bestQuote - avgQuote) / bestQuote;
        console.log("Quote variance:", quoteVariance);

        if (quoteVariance > 0.01) {
            console.log("Warning: Quote variance of", quoteVariance * 100, "% detected");
        }

        // Check output amount vs expected
        const outputAmount = parseFloat(routerResult.toTokenAmount);
        const priceDiff = Math.abs((outputAmount - expectedPrice) / expectedPrice * 100);

        console.log("Output validation:");
        console.log("- Actual output:", outputAmount);
        console.log("- Expected output:", expectedPrice);
        console.log("- Price difference:", priceDiff, "%");
        console.log("- Slippage tolerance:", CONFIG.SLIPPAGE, "%");

        if (priceDiff > parseFloat(CONFIG.SLIPPAGE)) {
            throw new Error(`Output amount differs from expected by ${priceDiff}%`);
        }

        console.log("Quote validation passed ✅");
    }

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

// Enhanced Transaction Builder
// First, let's define some types
interface SignatureStatus {
    err: any | null;
    confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
    confirmations?: number | null;
    slot?: number;
}

interface SignatureStatusResponse {
    context: { slot: number };
    value: SignatureStatus | null;
}

class TransactionBuilder {
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

    static async sendAndConfirmProtectedTransaction(
        tx: Transaction | VersionedTransaction
    ): Promise<string> {
        const startTime = Date.now();
        const MAX_TIMEOUT = 120000; // 120 seconds
        const CHECK_INTERVAL = 3000; // Check every 3 seconds
        const CONFIRMATION_BLOCKS = 32;

        console.log("Preparing to send transaction with maximum priority...");

        // Add priority fee instruction
        if (tx instanceof Transaction) {
            const priorityFee = await this.getPriorityFee();
            console.log(`Using priority fee: ${priorityFee} microLamports`);

            const computeBudgetIx = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: priorityFee
            });
            tx.instructions.unshift(computeBudgetIx);
        }

        console.log("Sending transaction...");
        const txId = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: 5,
            preflightCommitment: 'confirmed'
        });

        console.log(`Transaction sent: ${txId}`);
        console.log(`Explorer URL: https://solscan.io/tx/${txId}`);
        console.log("Waiting for confirmation...");

        let lastStatus: SignatureStatus | null = null;
        try {
            // Get initial blockhash
            const { blockhash, lastValidBlockHeight } =
                await connection.getLatestBlockhash('confirmed');

            // Setup status monitoring
            const statusCheckPromise = new Promise<SignatureStatusResponse>(async (resolve, reject) => {
                const interval = setInterval(async () => {
                    try {
                        const status = await connection.getSignatureStatus(txId);

                        if (status.value !== lastStatus) {
                            console.log(`Status update: ${JSON.stringify(status.value || 'pending')}`);
                            lastStatus = status.value;
                        }

                        if (status.value?.confirmationStatus === 'confirmed' ||
                            status.value?.confirmationStatus === 'finalized') {
                            clearInterval(interval);
                            resolve(status);
                        } else if (status.value?.err) {
                            clearInterval(interval);
                            reject(new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`));
                        }
                    } catch (e) {
                        console.log("Error checking status:", e);
                    }
                }, CHECK_INTERVAL);

                // Set timeout
                setTimeout(() => {
                    clearInterval(interval);
                    reject(new Error('Transaction confirmation timeout - check explorer for final status'));
                }, MAX_TIMEOUT);
            });

            // Wait for confirmation or timeout
            const confirmation = await Promise.race([
                statusCheckPromise,
                connection.confirmTransaction({
                    signature: txId,
                    blockhash,
                    lastValidBlockHeight: lastValidBlockHeight + CONFIRMATION_BLOCKS
                }, 'confirmed')
            ]);

            // Check for errors
            if ('value' in confirmation && confirmation.value?.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            const duration = Date.now() - startTime;
            console.log(`Transaction confirmed in ${duration}ms`);
            console.log(`Final status: ${JSON.stringify(lastStatus)}`);
            return txId;

        } catch (error) {
            const duration = Date.now() - startTime;
            console.log(`Transaction processing time: ${duration}ms`);
            console.log("Last known status:", lastStatus);
            console.log("Check transaction status at:");
            console.log(`https://solscan.io/tx/${txId}`);
            throw error;
        }
    }

    static async getPriorityFee(): Promise<number> {
        try {
            const recentFees = await connection.getRecentPrioritizationFees();
            if (recentFees.length === 0) return CONFIG.PRIORITY_FEES.VERY_HIGH;

            const maxFee = Math.max(...recentFees.map(fee => fee.prioritizationFee));
            // More aggressive fee strategy
            return Math.min(maxFee * 3, CONFIG.PRIORITY_FEES.VERY_HIGH * 2);
        } catch {
            return CONFIG.PRIORITY_FEES.VERY_HIGH;
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

// Main execution function with MEV protection
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

    await MEVProtection.validateSwapSafety(quote, expectedAmount);
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

        const txId = await executeProtectedSwap(amount, fromTokenAddress, toTokenAddress);
        console.log("Transaction successful!");
        console.log("Transaction ID:", txId);
        console.log("Explorer URL:", `https://solscan.io/tx/${txId}`);
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