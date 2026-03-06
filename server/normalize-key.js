
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const keyPath = path.join(__dirname, 'service-account.json');
const rawData = fs.readFileSync(keyPath, 'utf8');
const keyData = JSON.parse(rawData);

try {
    console.log("Sanitizing private key...");
    const privateKey = crypto.createPrivateKey({
        key: keyData.private_key,
        format: 'pem',
        type: 'pkcs8'
    });

    const exported = privateKey.export({
        type: 'pkcs8',
        format: 'pem'
    });

    keyData.private_key = exported;
    fs.writeFileSync(keyPath, JSON.stringify(keyData, null, 2));
    console.log("Successfully sanitized and saved key.");
} catch (e) {
    console.error("Failed to sanitize key!");
    console.error(e);
}
