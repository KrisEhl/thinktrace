Agentic Deep Research with Token Factory and Tavily
Theme: Apps and Agentic AI
Challenge lead: Daniel Myers, Nebius DevRel
Partners: Tavily and Reflection AI

<br />
The challenge Build a research agent that turns a question into a sourced, verifiable answer. It should plan its searches, read what it finds, decide when it has enough evidence, and cite where every claim came from.

Start from the Nebius cookbook and take it somewhere the tutorial doesn't go: https://dev.nebius.com/cookbook/deep-research-agent-tavily

The cookbook gives you a working agent in about five minutes: a Token Factory model for reasoning, Tavily for web search and page extraction, and a planning loop that produces a cited report. Your job is to make it useful for a real research problem. Some directions:

Vendor or startup due diligence with a confidence rating per claim
Literature or market scans that start from a seed set and find what's missing
Monitoring agents that re-run a question on a schedule and report what changed
Multi-agent setups: a planner, parallel researchers, a fact-checker that tries to break the draft
Anything where "show me the sources" is the whole point
Models Any model in the Token Factory catalog. The cookbook defaults to MiniMax-M3. NVIDIA Nemotron 3.5 Super VL, Nemotron 3 Super and Nemotron 3 Nano are live and good at tool calling. Reflection AI's Beam 1.0, an open-weights 501B mixture-of-experts reasoning model with 23B active parameters, lands on Token Factory today, 16 October. Search the catalog for "Beam" to find it. Projects that use Beam are eligible for the Reflection credits below, but Beam is not required.

Recommended Reflection starter: Beam on Token Factory + Mirror + Tavily Mirror is Reflection's open-source coding harness, the one Beam was trained alongside, and the setup they recommend to get the most out of the model. It runs in your terminal, reads and edits files, runs commands, and can point at a custom model endpoint, so you can drive it with Beam on Token Factory. The challenge rules do not change: Token Factory for inference, Tavily for retrieval, same judging, same prizes.

Install: uv tool install reflection-mirror, then run mirror in your project. Docs: https://developers.reflection.ai/mirror-overview. Source: https://github.com/reflection-oss/mirror
Aksel from Reflection has a starter and extension examples ready and will set teams up onsite.
Found a model or harness problem? Use /bug and /bad-beam inside Mirror. Reflection reads every report.
Requirements

Primary inference runs on Nebius Token Factory
Web retrieval uses Tavily
Public GitHub repo with a README a judge can run from
2-minute demo video, submitted on the hackathon platform by 18:30
How you'll be judged Originality, creativity, use of the tools, and presentation. In practice: a judge clicks three citations at random and they hold up; the demo shows one complete run with no cuts around the hard part; the trace shows the agent making decisions, not following a script.

Prizes

Challenge winner: $1,000 Nebius AI Cloud credits, $1,000 Token Factory credits, $10,000 in Reflection AI API credits, and 30,000 Tavily credits
The winner demos in the grand final at 20:00 for an additional $10,000 Cloud, $10,000 Token Factory, and $10,000 Reflection AI credits
Side awards from Hugging Face and other partners are judged across all challenges and announced at the ceremony
Getting access

Token Factory: sign up at https://tokenfactory.nebius.com, redeem the promo code shown on the hackathon platform after you register, then create an API key. Sign-up asks for a card for verification; some German cards without 16 digits fail. If that happens, post here and we'll sort it out on the spot. Arseniy's walkthrough video of sign-up and promo code redemption is pinned in the tools-onboarding channel.
Tavily: sign up at https://app.tavily.com and copy your API key. The free tier covers a day of building; if you run out, post here.
Run the cookbook once end to end before you change anything. If the report has no sources, your Tavily key isn't set.
Using Claude Code, Codex or Cursor? Paste the cookbook URL and ask it to set you up. Token Factory's API reference for agents: https://docs.tokenfactory.nebius.com/llms.txt
Beam questions: Aksel from Reflection AI is onsite all day, and Reflection's community Discord is at https://discord.gg/reflectionai
About Nebius Nebius is the AI cloud for builders: GPU infrastructure, Serverless AI, and Token Factory, an inference platform for open models with an OpenAI-compatible API. Tavily, Nebius's web search and extraction API for agents, is what your agent uses to read the live web. Free credits and the builder program: https://dev.nebius.com/builders

