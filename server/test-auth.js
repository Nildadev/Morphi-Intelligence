
const { VertexAI } = require('@google-cloud/vertexai');
const path = require('path');

async function testAuth() {
    console.log("Starting Auth Test...");
    console.log("Node Version:", process.version);
    console.log("Current Directory:", process.cwd());
    console.log("NODE_OPTIONS:", process.env.NODE_OPTIONS);

    try {
        const project = 'gen-lang-client-0057918965';
        const location = 'us-central1';
        const keyPath = path.join(__dirname, 'service-account.json');

        console.log("Loading key from:", keyPath);

        const vertexAI = new VertexAI({
            project: project,
            location: location
            // Relying on GOOGLE_APPLICATION_CREDENTIALS env var
        });

        const model = vertexAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        console.log("Model instance created. Attempting to generate a dummy request...");

        // This will trigger a token request and signing
        const result = await model.generateContentStream({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
        console.log("Successfully started stream (signing worked).");
        process.exit(0);
    } catch (error) {
        console.error("Auth Test Failed!");
        console.error(error);
        process.exit(1);
    }
}

testAuth();
