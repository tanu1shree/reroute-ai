<h1 align="Center">ReRoute AI</h1>

ReRoute AI is an AI-assisted item recovery platform that helps users make sustainable decisions about unwanted belongings. Upload an item photo, receive an AI-based assessment, and explore four recovery pathways: **Repair, Reuse / Donate, Recycle, or Discard**.

## Features

- **AI Item Recognition:** Identifies items, categories, and apparent condition from photographs.
- **Condition Assessment:** Allows users to review or override condition information.
- **Recovery Recommendations:** Provides an actionable pathway, explanation, and alternative.
- **RAG Chatbot:** Answers follow-up questions using a curated recovery guideline library.
- **Source References:** Displays relevant guidelines used for chatbot responses.
- **Fallback Guidance:** Provides retrieved guidelines when AI generation is unavailable.
- **Impact Dashboard:** Tracks assessed items and recorded recovery outcomes using browser storage.

## Tech Stack

| Component | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript |
| Backend | Python, FastAPI |
| Computer Vision | Vision model via OpenRouter |
| Decision Engine | Python rule-based logic |
| Retrieval | BM25 keyword search |
| Generative AI | OpenRouter API |
| Knowledge Base | JSON |
| Dashboard | JavaScript, localStorage |
| Deployment | Docker, Vercel |

## Architecture

```text
Browser
   |
   |-- /api/analyze
   |       |
   |    FastAPI
   |       |
   |    vision.py
   |       |
   |    recommendation.py
   |       |
   |    Recovery Recommendation
   |
   |-- /api/chat/stream
           |
         rag.py
           |
      knowledge.json
           |
      openrouter.py
           |
       OpenRouter
```

## How It Works

1. **Image Input:** User uploads an item photograph.
2. **Recognition:** A vision model identifies the item and predicts its category and condition.
3. **Decision Engine:** Python rules evaluate item properties and determine a recovery pathway.
4. **Recommendation:** The user receives an explanation, next action, and alternative.
5. **AI Guidance:** The RAG chatbot retrieves relevant guidelines and generates follow-up answers.

### Core Components

- `vision.py` — Image preprocessing and AI-based recognition.
- `recommendation.py` — Item information, recovery rules, and recommendations.
- `rag.py` — BM25 retrieval and chatbot generation.
- `openrouter.py` — Centralised AI API integration.
- `main.py` — FastAPI routes and application setup.
- `knowledge.json` — Curated recovery guidelines.

## Project Structure

```text
ReRoute-AI/
├── app.py
├── vercel.json
├── Dockerfile
├── requirements.txt
├── .env
├── backend/
│   ├── main.py
│   ├── vision.py
│   ├── recommendation.py
│   ├── rag.py
│   ├── openrouter.py
│   ├── config.py
│   ├── errors.py
│   └── data/
│       └── knowledge.json
└── frontend/
    ├── index.html
    ├── style.css
    ├── app.js
    └── assets/
```

## Impact & Sustainability

ReRoute AI aligns with:

- **SDG 12 — Responsible Consumption and Production:** Promotes repair, reuse, donation, and recycling.
- **SDG 11 — Sustainable Cities and Communities:** Encourages responsible waste practices in residential communities.
- **SDG 13 — Climate Action:** Supports potential reductions in environmental impact through item recovery.

The prototype dashboard tracks assessed items, items kept in use, recycled items, and discarded items. Counts are stored locally in the browser.

## Limitations

- Image recognition cannot reliably detect hidden damage or verify functionality.
- Recommendations depend on predefined rules and available item information.
- Chatbot guidance is limited by the curated knowledge base.
- Dashboard data is browser-local, not centrally stored or independently verified.
- No measured environmental impact or large-scale recommendation validation is claimed.

## Future Development

- Improved item and condition recognition.
- More context-aware recovery recommendations.
- Verified local repair, donation, and recycling directories.
- Expanded RAG knowledge base.
- Persistent database and user feedback.
- ESG dashboard with outcome-based metrics and visualisations.

---