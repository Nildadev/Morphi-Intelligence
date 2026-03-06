async function test() {
    try {
        console.log("Fetching https://models.dev/api.json...");
        const response = await fetch('https://models.dev/api.json', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        console.log("Status:", response.status);
        if (response.ok) {
            const data = await response.json();
            console.log("Success! Found", data.length, "models.");
            console.log("First 2 items:", JSON.stringify(data.slice(0, 2), null, 2));
        } else {
            const text = await response.text();
            console.log("Error body:", text);
        }
    } catch (e) {
        console.error("Fetch failed:", e);
    }
}
test();
