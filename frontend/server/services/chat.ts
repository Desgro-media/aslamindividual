import { config } from "../config";
import { CHATBOT_KNOWLEDGE } from "../chatbotKnowledge";
import { CHATBOT_PSYFOS } from "../chatbotExtra";

// Public help chatbot — an OpenAI-compatible chat-completions call grounded in
// the embedded knowledge base. Degrades gracefully without an API key.

const SYSTEM_PROMPT =
    "You are an AI assistant for this practice. Answer the user's questions strictly using the following knowledge base. " +
    "Do not invent features or provide information outside of this text. Keep your responses concise and friendly. " +
    "If you don't know the answer based on the text, say 'I don't know'.\n\nKNOWLEDGE BASE:\n" + CHATBOT_KNOWLEDGE + CHATBOT_PSYFOS;

export async function chat(message: string): Promise<string> {
    if (!config.chatApiKey) return "The chat assistant isn't configured for this practice yet.";
    try {
        const res = await fetch(`${config.chatBaseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config.chatApiKey}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                model: config.chatModel,
                max_tokens: 1024,
                temperature: 0.7,
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: message },
                ],
            }),
            signal: AbortSignal.timeout(25_000),
        });
        if (res.ok) {
            const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
            const content = data.choices?.[0]?.message?.content;
            if (content) return content;
        }
        return "I received an empty response from the AI.";
    } catch (err) {
        console.error("[chat] AI request failed:", (err as Error).message);
        return "I'm sorry, I'm having trouble connecting to the AI service right now. Please try again later.";
    }
}
