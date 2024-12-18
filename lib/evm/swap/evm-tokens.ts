import { getHeaders } from '../../shared';

async function main() {
    try {
        const params = {
            chainId: '1' // Ethereum Chain ID
        };

        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/aggregator/all-tokens";
        const queryString = "?" + new URLSearchParams(params).toString();
        const headers = getHeaders(timestamp, "GET", requestPath, queryString);

        console.log('Getting Ethereum tokens...');
        const response = await fetch(`https://www.okx.com${requestPath}${queryString}`, {
            method: "GET",
            headers
        });

        const result = await response.json();
        // JSON response
        // console.log(JSON.stringify(result, null, 2));

        console.log(`API Code: ${result.code}`);
        console.log(`Message: ${result.msg || 'No message'}`);

        if (response.ok && result.code === "0") {
            console.log('\nToken List:');
            console.log('----------------------------------------');

            if (!result.data || result.data.length === 0) {
                console.log('No tokens found');
                return;
            }

            // Sort tokens by symbol
            const sortedTokens = result.data.sort((a: any, b: any) =>
                a.tokenSymbol.localeCompare(b.tokenSymbol)
            );

            // Display token information
            sortedTokens.forEach((token: any, index: number) => {
                console.log(`\n${index + 1}. ${token.tokenSymbol} (${token.tokenName})`);
                console.log(`   Address: ${token.tokenContractAddress}`);
                console.log(`   Decimals: ${token.decimals}`);
                console.log(`   Logo URL: ${token.tokenLogoUrl}`);
            });

            // Print summary
            console.log('\nSummary:');
            console.log('----------------------------------------');
            console.log(`Total Tokens: ${result.data.length}`);


            // Native Token Address
            const nativeAddresses = result.data.filter((token: any) =>
                token.tokenContractAddress.includes('EeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')
            );

            if (nativeAddresses.length > 0) {
                console.log('\nNative Token:');
                nativeAddresses.forEach((token: any) => {
                    console.log(`- ${token.tokenSymbol}: ${token.tokenContractAddress}`);
                });
            }

        } else {
            console.error('\nRequest failed:');
            console.error(`Status: ${response.status}`);
            console.error(`API Error: ${result.msg}`);
            process.exit(1);
        }

    } catch (error) {
        console.error('Script failed:', error);
        process.exit(1);
    }
}

main();