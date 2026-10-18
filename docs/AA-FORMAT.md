# Recorded Artificial Analysis format

Attribution: https://artificialanalysis.ai/models. The parser is offline-tested against exact model
object slices from a recorded Next.js response; surrounding page content is omitted. See
`test/fixtures/provenance.json` for the snapshot and payload filename. No source-machine path is embedded.

The recognizable signature is `{"slug":"…","name":"…","shortName"`. JSON objects can occur in raw
RSC text or inside JSON-escaped strings in `self.__next_f.push`. Locate the signature, scan balanced
braces while respecting strings/escapes, then JSON-decode. Do not use a greedy brace regex as a decoder.

| Raw field                                                | Core field          | Notes                                                        |
| -------------------------------------------------------- | ------------------- | ------------------------------------------------------------ |
| intelligenceIndex                                        | intelligence        | Index points; not a percentage                               |
| terminalBench40                                          | terminalBench       | Ratio 0–1                                                    |
| automationBenchPartialScore                              | automationBench     | Ratio 0–1                                                    |
| omniscienceAccuracy                                      | knowledgeAccuracy   | Ratio 0–1                                                    |
| omniscienceHallucinationRate                             | hallucinationRate   | Lower is better                                              |
| omniscienceNonHallucination                              | hallucinationRate   | Fallback conversion: 1 minus the raw value                   |
| intelligenceIndexOutputTokensPerTask.output              | outputTokensPerTask | Do not use input or total tokens                             |
| intelligenceIndexCost.total                              | cost                | Whole index cost, distinct from cost per task                |
| medianOutputTokensPerSecond                              | speed               | Fallback: timescaleData.medianOutputSpeed                    |
| medianTimeToFirstAnswerTokenSeconds                      | ttft                | Fallback: timeToFirstAnswerToken.total; includes reasoning   |
| contextWindowTokens                                      | context             | Tokens                                                       |
| price1mInputTokens / price1mOutputTokens / cacheHitPrice | price               | USD per million tokens                                       |
| effort.slug                                              | effort              | Explicit field preferred; named suffix/effort label fallback |

Missing measurements remain null. A model name can explicitly say “Max Effort” even when `effort`
is absent, as the recorded fixture demonstrates. Unknown reasoning effort is rejected. Non-reasoning
is `none`. Known source URLs resolve a slug to an existing product before fallback suffix stripping.
Unknown products remain provisional, unclassified and inaccessible until the user confirms them.

The source records do not reliably include measurement timestamps. Seed entries use an explicit
`dateKind: imported`; dates must not be presented as the date a benchmark ran. Optional refreshed
records use `dateKind: refreshed`, likewise denoting retrieval, not a new benchmark execution.
