// scripts/solana-swap.ts
import { getHeaders } from '../../shared';

async function getQuote(params: any) {
    const timestamp = new Date().toISOString();
    const requestPath = "/api/v5/dex/aggregator/swap";
    const queryString = "?" + new URLSearchParams({
        ...params,
    }).toString();

    const headers = getHeaders(timestamp, "GET", requestPath, queryString);
    const response = await fetch(`https://www.okx.com${requestPath}${queryString}`, {
        method: "GET",
        headers
    });

    const data = await response.json();
    return data;
}

async function main() {
    try {
        console.log('Getting Solana swap data...');

        const quote = await getQuote({
            chainId: '501',
            amount: '10000000000',
            fromTokenAddress: 'So11111111111111111111111111111111111111112',
            toTokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            userWalletAddress: "HghFVR3KBYcbgh63cJYmCCu9mzUYMYQRPT5aMrCutMct",
            slippage: '0.1',
            autoSlippage: "true",
            maxAutoSlippageBps: "100"
        });

        console.log(JSON.stringify(quote, null, 2));

    } catch (error) {
        console.error('Failed to get quote:', error);
        process.exit(1);
    }
}

main();