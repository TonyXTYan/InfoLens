---
title: Info Lens
emoji: 🔭
colorFrom: blue
colorTo: red
sdk: docker
short_description: Explore the informational nature of LLMs and language.
tags:
  - llm-interpretability
  - text-analysis
  - information
  - visualization
app_port: 7860
pinned: false
license: apache-2.0
---

# Info Lens

A toolbox at the intersection of LLMs, linguistics, and information theory.

**Site:** https://info-lens.app/

## Products

### LLM Causal Flow
Explore how context attributes across a generation (DAG view).

<img src="client/src/assets/images/dag-dark.gif" width="460" alt="LLM Causal Flow" />

### Info Highlight
Highlight the informative / high-surprisal parts of text. Also as a [Chrome extension](https://chromewebstore.google.com/detail/info-highlight/gemajnklkebeikmfphiddpjfimahacdk).

<img src="client/src/assets/images/highlight.png" width="460" alt="Info Highlight" />

<img src="client/src/assets/images/info-highlight-styles.png" width="460" alt="Info Highlight styles" />

<img src="client/src/assets/images/info-highlight-demo.png" width="460" alt="Info Highlight demo" />

### Semantic Highlight
Chrome extension: search and highlight words by meaning.

[Chrome Web Store](https://chromewebstore.google.com/detail/semantic-highlight/jnjglfjkbopeiodpcgmlhkfhldjfcdda)

<img src="client/src/assets/images/小型宣传图块.png" width="460" alt="Semantic Highlight" />

## Also
- [Context Attribution](https://info-lens.app/attribution)
- [LLM Raw Chat](https://info-lens.app/chat)
- [Hugging Face Space](https://huggingface.co/spaces/dqy08/InfoLens)

## Develop locally

Most people only need the site or extensions. For contributors:

**Frontend** (webpack dev server):

```bash
cd client/src && npm ci && npm start
```

**Backend** (loads models; use `--no-facade-token` for local API without the production facade):

```bash
pip install -r requirements.txt
python run.py --no-facade-token
```

Default backend port is `5001`.

**Docker** builds the same stack used on the Hugging Face Space (heavy; pulls models). Prefer the Space or site unless you need a self-hosted container:

```bash
docker build -t infolens .
docker run -p 7860:7860 infolens
```

## Legacy name: InfoRadar

InfoRadar is the former project and repo name. It still appears in parts of the codebase.

## License

Apache 2.0. Copyright and attribution: see [NOTICE](NOTICE).
