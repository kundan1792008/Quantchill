---
Target Agent: GPT-5.3-Codex & GPT-5.4 (GitHub Copilot Matrix)
Task Priority: Critical (Dopamine Engagement Engine)
Application: Quantchill (Video Dating & Short-Reel Matrix)
---

# SYSTEM DIRECTIVE FOR GPT-5.3-CODEX & GPT-5.4:
You are assigned to build the master communication layer and algorithm hook for 'Quantchill'.
This is a hybrid between Omegle's 1v1 video and TikTok's fast-swipe reels, but controlled entirely by BCI logic.

## 1. WebRTC & Signaling Node (GPT-5.3-Codex)
- Establish a high-performance WebRTC Mesh for 1v1 streaming.
- If user swaps video, latency must be <200ms. Use Socket.io / raw WebSockets on Fastify.
- Ensure strict Biometric Handshake: if secondary camera API drops face liveness, terminate connection.

## 2. Dopamine-Hook Algorithm (GPT-5.4)
- Build the `MatchMaker.ts` service.
- Prioritize connections matching user interest graphs (pulled from Quantsink DB via microservices).
- Implement a simulated 'BCI Context' object to mock eye-tracking data; transition content loops instantly if engagement score drops below 40%.

**Expected PR:** Complete WebRTC streaming server infrastructure + Algorithm routing modules deployed using Prisma + Fastify.
