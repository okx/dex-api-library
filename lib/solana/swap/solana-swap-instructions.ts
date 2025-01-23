// scripts/solana-swap-instruction.ts
import cryptoJS from "crypto-js";
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface SwapParams {
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

function getHeaders(timestamp: string, method: string, path: string, queryString = ""): Record<string, string> {
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

async function getSwapInstruction(params: any) {
    const baseUrl = 'https://beta.okex.org';
    const requestPath = '/api/v5/dex/aggregator/swap-instruction';
    const queryString = '?' + new URLSearchParams(params).toString();
    const timestamp = new Date().toISOString();

    // Get full headers including authentication
    const headers = getHeaders(
        timestamp,
        "GET",
        `/api/v5/dex${requestPath}`,
        queryString
    );

    try {
        const response = await fetch(`${baseUrl}${requestPath}${queryString}`, {
            method: 'GET',
            headers
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Response error:', errorText);
            throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
        }

        const data = await response.json();
        if (!data.data?.[0]) {
            console.log("Full API response:", JSON.stringify(data, null, 2));
            throw new Error(`OKX API error: ${data.msg || 'No instructions received'}`);
        }

        return data;
    } catch (error) {
        console.error('Error fetching swap instruction:', error);
        throw error;
    }
}

async function main() {
    try {
        console.log('Getting Solana swap instruction...');

        if (!process.env.OKX_API_KEY || !process.env.OKX_SECRET_KEY || !process.env.OKX_API_PASSPHRASE) {
            throw new Error('Missing required OKX API credentials in environment variables');
        }

        const swapParams: SwapParams = {
            chainId: '501',
            amount: '350000000',
            fromTokenAddress: '11111111111111111111111111111111',
            toTokenAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
            slippage: '0.05',
            priceImpactProtectionPercentage: '1',
            userWalletAddress: 'FvUDkjR1STZ3c6g3DjXwLsiQ477t2HGH4LQ81xMKWJZk',
            feePercent: '1',
            fromTokenReferrerWalletAddress: '39sXPZ4rD86nA3YoS6YgF5sdutHotL87U6eQnADFRkRE'
        };

        const swapInstruction = await getSwapInstruction(swapParams);
        console.log(JSON.stringify(swapInstruction, null, 2));

    } catch (error) {
        console.error('Failed to get swap instruction:', error);
        process.exit(1);
    }
}

main();