---
name: search
description: Explains when to choose TinyFish, Exa, or Parallel for web search, scraping, and deep research. Load this skill only when performing search queries or selecting search tools.
---

# Search Tools: TinyFish, Exa, and Parallel

This guide explains when to use **TinyFish**, **Exa**, or **Parallel** for search, page retrieval, and data gathering. This file is user-editable — tweak provider preferences, default limits, or local guidelines to fit your workflow.

## Quick Summary

| Provider     | Best For                                                                  | Execution Style                                                       | Approval / Trust                                                                                      |
| :----------- | :------------------------------------------------------------------------ | :-------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| **TinyFish** | Direct URL extraction, page fetching, and multi-step web automation       | Reads are synchronous; complex workflows run as async background jobs | `tools.tinyfish.fetch.*` and `tools.tinyfish.search.*` are safe reads; automation runs use async jobs |
| **Exa**      | Semantic search, technical research, finding pages by concept, clean text | Fast synchronous search calls designed for LLM context windows        | Search calls are read-only; clean markdown extracts without page clutter                              |
| **Parallel** | Multi-query exploration, comparative surveys, cross-source verification   | Multiple queries fired concurrently across providers/topics           | Batched or parallel read calls to reduce roundtrip latency                                            |

---

## When to Use TinyFish

Use **TinyFish** when the task requires interacting with real web pages or extracting data from specific URLs.

- **URL Fetching**: You already have one or more exact target URLs and need the rendered text or raw HTML (`tools.tinyfish.fetch.root.fetchUrls`).
- **Dynamic & JS-Heavy Pages**: Pages that require headless rendering to reveal content.
- **Web Automation**: Multi-step navigation, form interaction, or downloading reports across pages via asynchronous jobs (`tools.tinyfish.agent.automation.runAsync`).
- **Built-in Integration**: TinyFish manifests are shipped out-of-the-box in `config.default.yaml`.

**Avoid when**:

- You only need high-level conceptual answers or broad link discovery across the web (use Exa).
- You need concurrent searches across different topics with minimal latency (use Parallel).

---

## When to Use Exa

Use **Exa** (formerly Metaphor) when you need high-signal neural or semantic search optimized for LLMs.

- **Semantic & Natural Language Queries**: Finding documents where keywords alone are insufficient (e.g. "case studies of migrating SQLite to WAL mode", "open-source MCP implementations").
- **Clean Markdown Extraction**: When reading full web pages directly into model context without ads, cookie banners, navigation menus, or boilerplate.
- **Similar Link Discovery**: Finding pages similar to an existing high-quality reference URL ("more like this").
- **Technical & Research Queries**: Finding authoritative documentation, company profiles, research papers, or niche technical blogs.

**Avoid when**:

- The page requires user interaction, multi-step navigation, or logging into an account (use TinyFish or browser CLI).
- You need to fetch an exact URL you already possess (use TinyFish `fetchUrls`).

---

## When to Use Parallel

Use **Parallel** search when investigating complex or multi-faceted questions that benefit from running multiple queries simultaneously.

- **Broad Exploratory Research**: Decomposing a complex user question into 3–5 orthogonal search angles executed concurrently.
- **Cross-Verification & Fact-Checking**: Checking claims across multiple independent search queries or providers in parallel.
- **Comparative Analysis**: Comparing multiple vendors, libraries, or approaches at once (e.g. querying specifications for three different tools in the same turn).
- **Latency Optimization**: Firing independent search requests simultaneously instead of waiting for serial tool roundtrips.

**Avoid when**:

- A single specific query or direct URL fetch is sufficient.
- The second search step depends strictly on what the first search returns.

---

## Customization

Users can customize search behaviors in `$DATA_DIR/config.yaml`:

- Add or override search tool globs under `mcp_servers.<server>.tools.read` to ensure read-only status.
- Configure custom search integrations as `async_jobs` if they run asynchronously.
