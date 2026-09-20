# Model-free memory extraction

Status: research and proposed design, not an implemented semantic extractor. The current Rust importer splits changed Markdown into paragraphs and creates deduplicated private candidates. It makes no model calls.

## Relevant research

- Chiticariu, Li, and Reiss (EMNLP 2013), [Rule-Based Information Extraction is Dead! Long Live Rule-Based Information Extraction Systems!](https://aclanthology.org/D13-1079/). Describes the practical value of declarative, interpretable extraction rules and their maintenance costs. This supports explicit domain rules, not a claim that rules understand arbitrary conversations.
- Mihalcea and Tarau (EMNLP 2004), [TextRank: Bringing Order into Text](https://aclanthology.org/W04-3252/). Uses graph ranking for keyword and sentence extraction without a trained language model. Useful for selecting original sentences in longer notes; centrality does not establish truth, durable value, or permission to share.
- Campos et al. (ECIR 2018), [A Text Feature Based Automatic Keyword Extraction Method for Single Documents](https://repositorio.inesctec.pt/server/api/core/bitstreams/90459f60-012f-4aa2-88cf-6af2a3a12559/content). The YAKE approach uses local statistical features to rank keywords without a training corpus. The [authors' implementation and later publications](https://github.com/INESCTEC/yake) provide follow-up material. Keyword extraction can support labels and retrieval; it does not extract complete factual propositions or resolve negation.

These papers concern general information extraction, keywords, and summarization. They do not demonstrate a complete multi-agent memory system. Applying their methods here is a design proposal requiring evaluation on real memory tasks.

## Recommended default

Use a deterministic, model-free pipeline:

1. Accept structured host records or explicitly registered Markdown. Preserve the supplied author, project, timestamp, and original evidence. Do not infer authorship from prose.
2. Parse structured fields and explicit memory sections first. For free text, use small language-specific rules for explicit preferences or decisions and retain the entire supporting sentence. A regex match alone does not establish scope or intent.
3. Preserve negation and temporary qualifiers. Quoted speech, examples, hypotheticals, third-party statements, and ambiguous pronouns should cause abstention or manual review. For example, “Use English only this time” must not become a permanent language preference.
4. Deduplicate exact normalized text. Treat lexical similarity as a duplicate suggestion rather than authority to merge facts; “use X” and “do not use X” may be lexically close.
5. Emit private candidates with evidence and the extraction rule/version. Confirmation, conflict resolution, and sharing remain separate versioned actions. Never broaden audience based on text content.

Start with structured parsing and explicit rules. Add YAKE-style labels only if retrieval evaluation shows benefit. Consider TextRank for long documents, with bounded input size; it is unnecessary for short preference statements. Chinese requires separate segmentation/rule evaluation rather than assuming English results transfer.

An optional host-supplied proposal can reuse an agent already processing a task, avoiding a second model request by Co-memo. That path still uses AI in the host and may add output tokens; it must not be described as model-free. Local embedding models likewise avoid cloud APIs but are still learned models and consume resources.

## Evaluation before enabling automatic extraction

Use English and Chinese examples covering explicit preferences, temporary instructions, quotations, negation, corrections, changed preferences, unrelated text, and conflicting subjects. Measure candidate precision/recall, erroneous permanent-preference creation, evidence retention, and correct abstention. Measure idle/active memory, CPU, and latency on the actual Rust implementation. The cited papers are not performance measurements of Co-memo.
