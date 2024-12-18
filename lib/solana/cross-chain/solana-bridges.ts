// sui-supported-bridges.ts
import { getHeaders } from '../../shared';

async function main() {
    try {
        const chainId = '501'; // Solana Chain ID
        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/cross-chain/supported/bridges";
        const queryString = chainId ? `?chainId=${chainId}` : '';
        const headers = getHeaders(timestamp, "GET", requestPath, queryString);

        console.log('Getting supported bridges for Solana...');
        const response = await fetch(`https://www.okx.com${requestPath}${queryString}`, {
            method: "GET",
            headers
        });

        const data = await response.json();
        console.log('Supported bridges response:', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Script failed:', error);
        process.exit(1);
    }
}

main();