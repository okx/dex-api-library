// swap.ts
import base58 from "bs58";
import BN from "bn.js";
import * as solanaWeb3 from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import cryptoJS from "crypto-js";
import dotenv from 'dotenv';

dotenv.config();

// Environment variables
const apiKey = process.env.OKX_API_KEY;
const secretKey = process.env.OKX_SECRET_KEY;
const apiPassphrase = process.env.OKX_API_PASSPHRASE;
const projectId = process.env.OKX_PROJECT_ID;
const userAddress = process.env.WALLET_ADDRESS;
const userPrivateKey = process.env.PRIVATE_KEY;
const solanaRpcUrl = process.env.SOLANA_RPC_URL;
const solanaWsUrl = process.env.SOLANA_WS_URL;
// Constants
const SOLANA_CHAIN_ID = "501";
const COMPUTE_UNITS = 300000;
const MAX_RETRIES = 3;

const connection = new Connection(`${solanaRpcUrl}`, {
    confirmTransactionInitialTimeout: 5000,
    wsEndpoint: solanaWsUrl,
});



function getHeaders(timestamp: string, method: string, requestPath: string, queryString = "") {
    if (!apiKey || !secretKey || !apiPassphrase || !projectId) {
        throw new Error("Missing required environment variables");
    }

    const stringToSign = timestamp + method + requestPath + queryString;
    return {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": cryptoJS.enc.Base64.stringify(
            cryptoJS.HmacSHA256(stringToSign, secretKey)
        ),
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": apiPassphrase,
        "OK-ACCESS-PROJECT": projectId,
    };
}

async function getTokenInfo(fromTokenAddress: string, toTokenAddress: string) {
    const timestamp = new Date().toISOString();
    const requestPath = "/api/v5/dex/aggregator/quote";
    const params = {
        chainId: SOLANA_CHAIN_ID,
        fromTokenAddress,
        toTokenAddress,
        amount: "1000000", // small amount just to get token info
        slippage: "0.5",
    };

    const queryString = "?" + new URLSearchParams(params).toString();
    const headers = getHeaders(timestamp, "GET", requestPath, queryString);

    const response = await fetch(
        `https://www.okx.com${requestPath}${queryString}`,
        { method: "GET", headers }
    );

    if (!response.ok) {
        throw new Error(`Failed to get quote: ${await response.text()}`);
    }

    const data = await response.json();
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

function convertAmount(amount: string, decimals: number) {
    try {
        if (!amount || isNaN(parseFloat(amount))) {
            throw new Error("Invalid amount");
        }
        const value = parseFloat(amount);
        if (value <= 0) {
            throw new Error("Amount must be greater than 0");
        }
        return new BN(value * Math.pow(10, decimals)).toString();
    } catch (err) {
        console.error("Amount conversion error:", err);
        throw new Error("Invalid amount format");
    }
}

async function main() {
    try {
        const args = process.argv.slice(2);
        if (args.length < 3) {
            console.log("Usage: ts-node swap.ts <amount> <fromTokenAddress> <toTokenAddress>");
            console.log("Example: ts-node swap.ts 1.5 11111111111111111111111111111111 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
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
        const quoteParams = {
            chainId: SOLANA_CHAIN_ID,
            amount: rawAmount,
            fromTokenAddress,
            toTokenAddress,
            slippage: "0.5",
            userWalletAddress: userAddress,
        } as Record<string, string>;

        // Get swap data
        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/aggregator/swap";
        const queryString = "?" + new URLSearchParams(quoteParams).toString();
        const headers = getHeaders(timestamp, "GET", requestPath, queryString);

        console.log("Requesting swap quote...");
        const response = await fetch(
            `https://www.okx.com${requestPath}${queryString}`,
            { method: "GET", headers }
        );

        const data = await response.json();
        if (data.code !== "0") {
            throw new Error(`API Error: ${data.msg}`);
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

        console.log("\nExecuting swap transaction...");
        let retryCount = 0;
        while (retryCount < MAX_RETRIES) {
            try {
                if (!swapData || (!swapData.tx && !swapData.data)) {
                    throw new Error("Invalid swap data structure");
                }

                const transactionData = swapData.tx?.data || swapData.data;
                if (!transactionData || typeof transactionData !== 'string') {
                    throw new Error("Invalid transaction data");
                }

                const recentBlockHash = await connection.getLatestBlockhash();
                console.log("Got blockhash:", recentBlockHash.blockhash);

                const decodedTransaction = base58.decode(transactionData);
                let tx;

                try {
                    tx = solanaWeb3.VersionedTransaction.deserialize(decodedTransaction);
                    console.log("Successfully created versioned transaction");
                    tx.message.recentBlockhash = recentBlockHash.blockhash;
                } catch (e) {
                    console.log("Versioned transaction failed, trying legacy:", e);
                    tx = solanaWeb3.Transaction.from(decodedTransaction);
                    console.log("Successfully created legacy transaction");
                    tx.recentBlockhash = recentBlockHash.blockhash;
                }

                const computeBudgetIx = solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({
                    units: COMPUTE_UNITS
                });

                const feePayer = solanaWeb3.Keypair.fromSecretKey(
                    base58.decode(userPrivateKey)
                );

                if (tx instanceof solanaWeb3.VersionedTransaction) {
                    tx.sign([feePayer]);
                } else {
                    tx.partialSign(feePayer);
                }

                const txId = await connection.sendRawTransaction(tx.serialize(), {
                    skipPreflight: false,
                    maxRetries: 5
                });

                const confirmation = await connection.confirmTransaction({
                    signature: txId,
                    blockhash: recentBlockHash.blockhash,
                    lastValidBlockHeight: recentBlockHash.lastValidBlockHeight
                }, 'confirmed');

                if (confirmation?.value?.err) {
                    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
                }

                console.log("\nSwap completed successfully!");
                console.log("Transaction ID:", txId);
                console.log("Explorer URL:", `https://solscan.io/tx/${txId}`);

                process.exit(0);
            } catch (error) {
                console.error(`Attempt ${retryCount + 1} failed:`, error);
                retryCount++;

                if (retryCount === MAX_RETRIES) {
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
            }
        }
    } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : "Unknown error");
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}