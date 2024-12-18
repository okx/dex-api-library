import { getHeaders } from '../../shared';

async function main() {
    try {
        const chainId = '1'; // Ethereum Chain ID
        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/aggregator/supported/chain";
        const queryString = chainId ? `?chainId=${chainId}` : '';
        const headers = getHeaders(timestamp, "GET", requestPath, queryString);

        console.log('Getting supported chain info for Ethereum...');
        const response = await fetch(`https://www.okx.com${requestPath}${queryString}`, {
            method: "GET",
            headers
        });

        const result = await response.json();
        // JSON response
        // console.log(JSON.stringify(result, null, 2));

        const data = result.data[0];
        console.log('Chain Details:');
        console.log('----------------------------------------');
        console.log(`Chain ID: ${data.chainId}`);
        console.log(`Chain Name: ${data.chainName}`);
        console.log(`Dex Approval Address: ${data.dexTokenApproveAddress}`);
    } catch (error) {
        console.error('Script failed:', error);
        process.exit(1);
    }
}

main();