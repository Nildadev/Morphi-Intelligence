const https = require('https');

function test() {
    console.log("Fetching https://models.dev/api.json via https module...");
    https.get('https://models.dev/api.json', {
        headers: {
            'User-Agent': 'Node.js'
        }
    }, (res) => {
        console.log('Status code:', res.statusCode);
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            console.log('Success! Length:', data.length);
            try {
                const json = JSON.parse(data);
                console.log('Keys:', Object.keys(json));
                const firstProvider = Object.keys(json)[0];
                console.log(`Sample provider [${firstProvider}]:`, JSON.stringify(json[firstProvider]).substring(0, 500));
            } catch (e) {
                console.log('Parse error:', e.message);
                console.log('First 100 chars:', data.substring(0, 100));
            }
        });
    }).on('error', (err) => {
        console.error('Error:', err.message);
    });
}
test();
