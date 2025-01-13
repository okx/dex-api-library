import base58 from "bs58";
import BN from "bn.js";
import {
    Connection,
    ComputeBudgetProgram,
    Transaction,
    TransactionInstruction,
    Keypair,
    PublicKey,
    TransactionInstructionCtorFields
} from "@solana/web3.js";
import cryptoJS from "crypto-js";
import dotenv from 'dotenv';
import { getHeaders } from '../../shared';

// Load environment variables
dotenv.config();

// Types and Interfaces
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

type SwapParams = Record<string, string> & {
    chainId: string;
    amount: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    slippage: string;
    priceImpactProtectionPercentage: string;
    userWalletAddress: string;
    feePercent: string;
    fromTokenReferrerWalletAddress: string;
}

interface RouteInfo {
    dexName: string;
    percentage: number;
    priceImpact: number;
}

// Configuration
const CONFIG = {
    CHAIN_ID: "501",
    BASE_COMPUTE_UNITS: 300000,
    MAX_COMPUTE_UNITS: 1200000,
    SLIPPAGE_BPS: 50,
    MIN_COMPUTE_UNITS: 1_000_000,
    PRIORITY_FEE_MULTIPLIER: 3,
    MAX_PRIORITY_FEE: 1_000_000,
    MAX_RETRIES: 3
};

// OKX API Class with combined functionality
class OKXApi {
    private static readonly BASE_URL = "https://beta.okex.org";
    private static readonly BASE_URL_QUOTE = "https://www.okx.com";

    static async getTokenInfo(fromTokenAddress: string, toTokenAddress: string): Promise<SwapQuote> {
        try {
            const timestamp = new Date().toISOString();
            const path = "/api/v5/dex/aggregator/quote";
            const params = new URLSearchParams({
                chainId: CONFIG.CHAIN_ID,
                fromTokenAddress,
                toTokenAddress,
                amount: "1000000",
                slippage: (CONFIG.SLIPPAGE_BPS / 10000).toString()
            });
            const queryString = `?${params.toString()}`;

            // Get headers using the imported function
            const headers = {
                ...getHeaders(timestamp, "GET", path, queryString),
            };

            const response = await fetch(
                `${this.BASE_URL_QUOTE}${path}${queryString}`,
                {
                    method: "GET",
                    headers
                }
            );

            const data = await response.json();
            if (!response.ok || !data.data?.[0]) {
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
        } catch (error) {
            console.error('Token info fetch failed:', error);
            throw error;
        }
    }

    static async getSwapInstructions(params: SwapParams): Promise<any> {
        try {
            console.log("\nGetting swap instructions...");
            const requestPath = '/api/v5/dex/aggregator/swap-instruction';
            const queryString = '?' + new URLSearchParams(params).toString();
            const timestamp = new Date().toISOString();

            // Get headers using the imported function
            const headers = {
                ...getHeaders(timestamp, "GET", requestPath, queryString),
                'X-Requestid': '11111111123232323',
                'Cookie': 'locale=en-US'
            };

            console.log('Request URL:', `${this.BASE_URL}${requestPath}${queryString}`);
            console.log('Using authentication headers');

            const response = await fetch(
                `${this.BASE_URL}${requestPath}${queryString}`,
                {
                    method: 'GET',
                    headers
                }
            );

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Response error:', errorText);
                console.error('Response status:', response.status);
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            console.log("---------------------------BREAKPOINT--------------------------")
            console.log(JSON.stringify(data, null, 2));
            console.log("---------------------------BREAKPOINT--------------------------")
            if (!data.data?.[0]) {
                console.log("Full API response:", JSON.stringify(data, null, 2));
                throw new Error('No swap instructions received');
            }

            console.log("Swap instructions received successfully");
            return data.data[0];
        } catch (error) {
            console.error('Failed to get swap instructions:', error);
            throw error;
        }
    }
}

// Transaction builder with MEV protection
class TransactionBuilder {
    static async buildAndSignTransaction(
        connection: Connection,
        instructions: any,
        feePayer: Keypair
    ): Promise<Transaction> {
        const transaction = new Transaction();
        const { blockhash } = await connection.getLatestBlockhash('finalized');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = feePayer.publicKey;

        // Add compute budget instructions for MEV protection
        transaction.add(
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: Math.floor(50_000 * CONFIG.PRIORITY_FEE_MULTIPLIER)
            }),
            ComputeBudgetProgram.setComputeUnitLimit({
                units: Math.max(CONFIG.BASE_COMPUTE_UNITS, CONFIG.MIN_COMPUTE_UNITS)
            })
        );

        // Add setup instructions
        if (instructions.setupInstructions?.length) {
            instructions.setupInstructions.forEach((ix: TransactionInstructionCtorFields) => {
                transaction.add(new TransactionInstruction(ix));
            });
        }

        // Add main swap instruction
        if (instructions.swapInstruction) {
            transaction.add(new TransactionInstruction(instructions.swapInstruction));
        }

        // Add cleanup instruction
        if (instructions.cleanupInstruction) {
            transaction.add(new TransactionInstruction(instructions.cleanupInstruction));
        }

        return transaction;
    }

    static async sendAndConfirmTransaction(
        connection: Connection,
        transaction: Transaction,
        feePayer: Keypair
    ): Promise<string> {
        try {
            transaction.partialSign(feePayer);

            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    maxRetries: CONFIG.MAX_RETRIES
                }
            );

            console.log(`\nTransaction sent: ${signature}`);

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
            console.error('Transaction send error:', error);
            throw error;
        }
    }
}

// Main swap execution function
async function executeSwap(
    amount: string,
    fromTokenAddress: string,
    toTokenAddress: string
): Promise<string> {
    try {
        console.log("\nStarting swap execution...");
        console.log("Input parameters:", { amount, fromTokenAddress, toTokenAddress });

        const connection = new Connection(process.env.SOLANA_RPC_URL!);
        const feePayer = Keypair.fromSecretKey(
            Uint8Array.from(base58.decode(process.env.PRIVATE_KEY!))
        );

        // Convert amount for USDC (6 decimals) or SOL (9 decimals)
        let inputAmount: string;
        if (fromTokenAddress === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
            inputAmount = Math.floor(parseFloat(amount) * 1e6).toString();
            console.log("Converting USDC amount:", amount, "to:", inputAmount);
        } else if (fromTokenAddress === "11111111111111111111111111111111") {
            inputAmount = Math.floor(parseFloat(amount) * 1e9).toString();
            console.log("Converting SOL amount:", amount, "to:", inputAmount);
        } else {
            inputAmount = amount;
        }

        const swapParams: SwapParams = {
            chainId: CONFIG.CHAIN_ID,
            amount: inputAmount,
            fromTokenAddress,
            toTokenAddress,
            slippage: "0.05",
            priceImpactProtectionPercentage: "1",
            userWalletAddress: feePayer.publicKey.toString(),
            feePercent: "1",
            fromTokenReferrerWalletAddress: "39sXPZ4rD86nA3YoS6YgF5sdutHotL87U6eQnADFRkRE",
        };

        // Get swap instructions using the working implementation
        console.log("Fetching swap instructions...");
        const swapInstructions = await OKXApi.getSwapInstructions(swapParams);

        // Add validation for the instructions
        if (!swapInstructions.setupInstructions && !swapInstructions.swapInstruction) {
            throw new Error("No valid swap instructions in response");
        }

        // Build and sign transaction
        console.log("Building transaction...");
        const transaction = await TransactionBuilder.buildAndSignTransaction(
            connection,
            swapInstructions,
            feePayer
        );

        // Execute swap
        console.log("Sending transaction...");
        const signature = await TransactionBuilder.sendAndConfirmTransaction(
            connection,
            transaction,
            feePayer
        );

        console.log("\nSwap executed successfully!");
        console.log("Solscan URL:", `https://solscan.io/tx/${signature}`);

        return signature;
    } catch (error) {
        console.error("Swap execution failed:", error);
        throw error;
    }
}

// CLI execution
async function main() {
    try {
        if (!process.env.SOLANA_RPC_URL || !process.env.PRIVATE_KEY) {
            throw new Error('Missing required environment variables: SOLANA_RPC_URL and PRIVATE_KEY');
        }

        const [amount, fromTokenAddress, toTokenAddress] = process.argv.slice(2);
        if (!amount || !fromTokenAddress || !toTokenAddress) {
            console.log("Usage: ts-node swap.ts <amount> <fromTokenAddress> <toTokenAddress>");
            process.exit(1);
        }

        console.log("\nStarting swap with parameters:");
        console.log("Amount:", amount);
        console.log("From Token:", fromTokenAddress);
        console.log("To Token:", toTokenAddress);

        const signature = await executeSwap(amount, fromTokenAddress, toTokenAddress);
        console.log("\nTransaction ID:", signature);

    } catch (error) {
        console.error("\nError:", error instanceof Error ? error.message : "Unknown error");
        process.exit(1);
    }
}

// Execute if running directly
if (require.main === module) {
    main().catch(console.error);
}

// Exports
export {
    executeSwap,
    OKXApi,
    TransactionBuilder,
    CONFIG
};