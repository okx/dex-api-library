// scripts/evm-swap.ts
import { getHeaders } from '../../shared';

async function main() {
    try {
        const params = {
            chainId: '1', // Ethereum mainnet
            amount: '10000000000000000000', // 10 ETH
            fromTokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', // Native ETH
            toTokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
            userWalletAddress: "0x9163756d2a83a334de2cc0c3aa1df9a5fc21369d",
            slippage: "0.5",
            autoSlippage: "true",
            maxAutoSlippageBps: "100"
        };

        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/aggregator/swap";
        const queryString = "?" + new URLSearchParams(params).toString();
        const headers = getHeaders(timestamp, "GET", requestPath, queryString);

        console.log('Getting EVM quote...');
        const response = await fetch(`https://www.okx.com${requestPath}${queryString}`, {
            method: "GET",
            headers
        });

        const data = await response.json();
        console.log('Quote response:', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Script failed:', error);
        process.exit(1);
    }
}

main();
