// scripts/sui-swap.ts
import { getHeaders } from '../../shared';

async function main() {
    try {
        const params = {
            chainId: '784', // SUI Chain ID
            amount: '10000000000',
            fromTokenAddress: '0x2::sui::SUI',
            toTokenAddress: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
            userWalletAddress: "0xac5bceec1b789ff840d7d4e6ce4ce61c90d190a7f8c4f4ddf0bff6ee2413c33c",
            slippage: '0.1',
            autoSlippage: "true",
            maxAutoSlippageBps: "100"
        };

        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/aggregator/swap";
        const queryString = "?" + new URLSearchParams(params).toString();
        const headers = getHeaders(timestamp, "GET", requestPath, queryString);

        console.log('Getting SUI quote...');
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