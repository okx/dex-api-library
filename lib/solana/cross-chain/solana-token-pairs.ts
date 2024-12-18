// sui-bridge-pairs.ts
import { getHeaders } from '../../shared';

async function main() {
    try {
        const params = {
            fromChainId: '501' // Solana Chain ID
        };

        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/cross-chain/supported/bridge-tokens-pairs";
        const queryString = "?" + new URLSearchParams(params).toString();
        const headers = getHeaders(timestamp, "GET", requestPath, queryString);

        console.log('Getting bridge token pairs for Solana...');
        const response = await fetch(`https://www.okx.com${requestPath}${queryString}`, {
            method: "GET",
            headers
        });

        const data = await response.json();
        console.log('Bridge pairs response:', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Script failed:', error);
        process.exit(1);
    }
}

main();