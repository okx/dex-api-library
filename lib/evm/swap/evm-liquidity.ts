// scripts/get-liquidity.ts
import { getHeaders } from '../../shared';

async function main() {
    try {
        const params = {
            chainId: '1' // Ethereum Chain ID
        };

        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/aggregator/get-liquidity";
        const queryString = "?" + new URLSearchParams(params).toString();
        const headers = getHeaders(timestamp, "GET", requestPath, queryString);

        console.log('Getting Ethereum liquidity sources...');
        const response = await fetch(`https://www.okx.com${requestPath}${queryString}`, {
            method: "GET",
            headers
        });

        const result = await response.json();
        // JSON response
        // console.log(JSON.stringify(result, null, 2));
        if (response.ok && result.code === "0") {
            console.log('\nLiquidity Sources:');
            console.log('----------------------------------------');

            if (!result.data || result.data.length === 0) {
                console.log('No liquidity sources found');
                return;
            }

            // Group by protocol family
            const groupedSources = result.data.reduce((acc: any, source: any) => {
                const baseName = source.name.split(' V')[0];
                if (!acc[baseName]) {
                    acc[baseName] = [];
                }
                acc[baseName].push(source);
                return acc;
            }, {});

            // Display grouped results
            Object.entries(groupedSources).forEach(([protocol, versions]: [string, any]) => {
                console.log(`\n${protocol}:`);
                versions.forEach((source: any) => {
                    console.log(`  - ID: ${source.id}`);
                    console.log(`    Name: ${source.name}`);
                    console.log(`    Logo: ${source.logo}`);
                });
            });

            // Print summary
            console.log('\nSummary:');
            console.log('----------------------------------------');
            console.log(`Total Liquidity Sources: ${result.data.length}`);
            console.log(`Unique Protocols: ${Object.keys(groupedSources).length}`);

            // Print major protocols
            const majorProtocols = Object.entries(groupedSources)
                .filter(([_, versions]: [string, any]) => versions.length > 1)
                .map(([protocol, versions]: [string, any]) =>
                    `${protocol} (${versions.length} versions)`
                );

            console.log('\n Has Multiple LP:');
            majorProtocols.forEach(protocol => console.log(`- ${protocol}`));

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