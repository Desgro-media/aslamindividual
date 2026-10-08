"use client";

import React, { useState, useRef, useEffect } from "react";
import { MessageCircle, X, Send, Bot, User, Loader2 } from "lucide-react";

type Message = {
  id: string;
  text: string;
  isBot: boolean;
  animated?: boolean;
};

const TypewriterText = ({ text, onComplete }: { text: string; onComplete?: () => void }) => {
  const [displayed, setDisplayed] = useState("");
  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      setDisplayed(text.substring(0, i));
      i++;
      if (i > text.length) {
        clearInterval(interval);
        if (onComplete) onComplete();
      }
    }, 12);
    return () => clearInterval(interval);
  }, [text, onComplete]);
  return <>{displayed}</>;
};

export default function ChatbotWidget() {
  const [isOpen, setIsOpen]       = useState(false);
  const [messages, setMessages]   = useState<Message[]>([
    { id: "1", text: "Hi! I'm the Mindesk AI assistant. How can I help you today?", isBot: true, animated: false }
  ]);
  const [input, setInput]         = useState("");
  const [loading, setLoading]     = useState(false);
  const messagesEndRef             = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isOpen]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const userMessage = input.trim();
    setInput("");
    setMessages(prev => [...prev, { id: Date.now().toString(), text: userMessage, isBot: false }]);
    setLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "/api/v1";
      const res    = await fetch(`${apiUrl}/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ message: userMessage }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setMessages(prev => [...prev, { id: Date.now().toString() + "bot", text: data.response, isBot: true, animated: false }]);
    } catch {
      setMessages(prev => [...prev, { id: Date.now().toString() + "err", text: "I'm having trouble connecting right now. Please try again shortly.", isBot: true, animated: false }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* FAB — liquid glass with accent glow */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          style={{
            position: "fixed", bottom: 24, right: 24, zIndex: 9999,
            width: 58, height: 58, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--accent)",
            border: "none", cursor: "pointer",
            boxShadow: "0 8px 28px rgba(79,110,247,0.50), 0 3px 10px rgba(79,110,247,0.28), inset 0 1px 0 rgba(255,255,255,0.22)",
            transition: "all 0.28s cubic-bezier(0.34,1.56,0.64,1)",
            animation: "glowPulse 3s ease-in-out infinite",
          }}
          onMouseEnter={e => (e.currentTarget.style.transform = "scale(1.12) translateY(-2px)")}
          onMouseLeave={e => (e.currentTarget.style.transform = "scale(1)")}
        >
          <MessageCircle style={{ width: 26, height: 26, color: "#fff" }} />
        </button>
      )}

      {/* Chat panel — liquid glass */}
      {isOpen && (
        <div
          style={{
            position: "fixed", bottom: 24, right: 24, zIndex: 10000,
            width: 360, height: 540, maxHeight: "80vh",
            borderRadius: 28, overflow: "hidden",
            display: "flex", flexDirection: "column",
            background: "var(--glass-raised)",
            backdropFilter: "blur(var(--blur-lg)) saturate(var(--sat))",
            WebkitBackdropFilter: "blur(var(--blur-lg)) saturate(var(--sat))",
            border: "1px solid var(--glass-border)",
            boxShadow: "0 20px 60px rgba(0,0,0,0.18), 0 8px 24px var(--glass-shadow), inset 0 1px 0 var(--specular)",
            animation: "springIn 0.45s cubic-bezier(0.34,1.56,0.64,1) forwards",
          }}
        >
          {/* Header */}
          <div style={{
            padding: "16px 20px",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            flexShrink: 0,
            background: "var(--accent)",
            boxShadow: "0 4px 16px rgba(79,110,247,0.30)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 34, height: 34, borderRadius: "50%",
                background: "rgba(255,255,255,0.18)",
                border: "1px solid rgba(255,255,255,0.25)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Bot style={{ width: 18, height: 18, color: "#fff" }} />
              </div>
              <div>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: "#fff", margin: 0, lineHeight: 1.25 }}>Mindesk AI</h3>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.72)", margin: 0 }}>Ask me anything</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              style={{
                background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.20)",
                borderRadius: 10, padding: 6, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.2s ease",
              }}
              onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.28)")}
              onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.15)")}
            >
              <X style={{ width: 17, height: 17, color: "#fff" }} />
            </button>
          </div>

          {/* Messages */}
          <div style={{
            flex: 1, padding: "18px 16px",
            overflowY: "auto", display: "flex", flexDirection: "column", gap: 14,
            background: "transparent",
          }}>
            {messages.map(msg => (
              <div key={msg.id} style={{
                display: "flex",
                flexDirection: msg.isBot ? "row" : "row-reverse",
                alignItems: "flex-end", gap: 8,
              }}>
                {/* Avatar */}
                <div style={{
                  width: 26, height: 26, borderRadius: "50%",
                  background: msg.isBot ? "var(--accent-surface)" : "var(--accent)",
                  border: `1px solid ${msg.isBot ? "var(--accent-border)" : "transparent"}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}>
                  {msg.isBot
                    ? <Bot  style={{ width: 13, height: 13, color: "var(--accent)" }} />
                    : <User style={{ width: 13, height: 13, color: "#fff" }} />}
                </div>
                {/* Bubble */}
                <div style={{
                  maxWidth: "76%",
                  padding: "11px 15px",
                  borderRadius: 18,
                  borderBottomLeftRadius:  msg.isBot ? 4 : 18,
                  borderBottomRightRadius: msg.isBot ? 18 : 4,
                  background: msg.isBot ? "var(--glass)" : "var(--accent)",
                  backdropFilter: msg.isBot ? "blur(12px)" : "none",
                  WebkitBackdropFilter: msg.isBot ? "blur(12px)" : "none",
                  border: msg.isBot ? "1px solid var(--glass-border-dim)" : "none",
                  color: msg.isBot ? "var(--text-1)" : "#fff",
                  boxShadow: msg.isBot
                    ? "0 2px 10px var(--glass-shadow)"
                    : "0 4px 14px rgba(79,110,247,0.36)",
                  fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap",
                }}>
                  {msg.isBot && !msg.animated ? (
                    <TypewriterText text={msg.text} onComplete={() => {
                      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, animated: true } : m));
                    }} />
                  ) : (
                    msg.text
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <div style={{
                  width: 26, height: 26, borderRadius: "50%",
                  background: "var(--accent-surface)", border: "1px solid var(--accent-border)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <Bot style={{ width: 13, height: 13, color: "var(--accent)" }} />
                </div>
                <div style={{
                  padding: "11px 16px", borderRadius: 18, borderBottomLeftRadius: 4,
                  background: "var(--glass)", backdropFilter: "blur(12px)",
                  border: "1px solid var(--glass-border-dim)",
                  boxShadow: "0 2px 10px var(--glass-shadow)",
                }}>
                  <div className="typing-dots">
                    <span></span><span></span><span></span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input bar */}
          <div style={{
            padding: "14px 14px 16px",
            borderTop: "1px solid var(--glass-border-dim)",
            display: "flex", alignItems: "center", gap: 10,
            background: "rgba(255,255,255,0.10)",
            backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
          }}>
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSend()}
              placeholder="Type a message…"
              style={{
                flex: 1, padding: "11px 16px", borderRadius: 50,
                background: "var(--glass)",
                backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
                border: "1px solid var(--glass-border-dim)",
                color: "var(--text-1)", fontSize: 13, outline: "none",
                transition: "all 0.22s cubic-bezier(0.34,1.56,0.64,1)",
                boxShadow: "inset 0 2px 6px rgba(0,0,0,0.04)",
              }}
              onFocus={e => {
                e.currentTarget.style.borderColor = "var(--accent)";
                e.currentTarget.style.boxShadow = "0 0 0 3px var(--accent-surface), inset 0 2px 6px rgba(0,0,0,0.04)";
              }}
              onBlur={e => {
                e.currentTarget.style.borderColor = "var(--glass-border-dim)";
                e.currentTarget.style.boxShadow = "inset 0 2px 6px rgba(0,0,0,0.04)";
              }}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading}
              style={{
                width: 40, height: 40, borderRadius: "50%",
                background: input.trim() && !loading ? "var(--accent)" : "var(--glass)",
                border: input.trim() && !loading ? "none" : "1px solid var(--glass-border-dim)",
                color: input.trim() && !loading ? "#fff" : "var(--text-3)",
                boxShadow: input.trim() && !loading ? "0 4px 14px rgba(79,110,247,0.38)" : "none",
                cursor: input.trim() && !loading ? "pointer" : "not-allowed",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.22s cubic-bezier(0.34,1.56,0.64,1)",
              }}
            >
              <Send style={{ width: 16, height: 16, marginLeft: input.trim() && !loading ? 2 : 0 }} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
