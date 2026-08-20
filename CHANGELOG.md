# Changelog

## [0.6.0](https://github.com/ai-outfitter/pensieve/compare/v0.5.0...v0.6.0) (2026-08-20)


### Features

* install the Pi collector as a Pi package ([b0a17db](https://github.com/ai-outfitter/pensieve/commit/b0a17dbb96c37c07398b7baf7b0afe33405efbc1))
* install the Pi collector as a Pi package ([fb477c4](https://github.com/ai-outfitter/pensieve/commit/fb477c404feb60aa3024c9dc5efb0db5db9d26e5))
* upload oversized payloads through a presigned PUT ([57cd873](https://github.com/ai-outfitter/pensieve/commit/57cd873c3fef03ccfa049d8c0e85e79bd9ddc488))
* upload oversized payloads through a presigned PUT ([0105989](https://github.com/ai-outfitter/pensieve/commit/01059895209afe89b495d6ecc2579d33ca8b36a8))


### Bug Fixes

* a capture failure must not break the observed session ([08b0751](https://github.com/ai-outfitter/pensieve/commit/08b075169d850c5cb39845f8f3ff51c3a2bcbf47))
* act on the presign review ([6eb782b](https://github.com/ai-outfitter/pensieve/commit/6eb782b8a9a340c808c6039d126d2f4eecc506bb))

## [0.5.0](https://github.com/ai-outfitter/pensieve/compare/v0.4.0...v0.5.0) (2026-08-16)


### Features

* **importer:** import Claude Code, Codex, and pi transcripts into the sink ([c6fb080](https://github.com/ai-outfitter/pensieve/commit/c6fb08072cfea5b43e6453c3d9fffaeb1cbd626c))
* **importer:** import harness transcripts into the sink ([f5e993c](https://github.com/ai-outfitter/pensieve/commit/f5e993c2a2e1b61389460dfe9dc8521f14625841)), closes [#14](https://github.com/ai-outfitter/pensieve/issues/14)
* **importer:** keep the record digest the sink returns ([cef979f](https://github.com/ai-outfitter/pensieve/commit/cef979f77627ecbca2b8e355cfe1c382a99ed24c)), closes [#14](https://github.com/ai-outfitter/pensieve/issues/14)
* **server:** read the record — payload bytes and a session index ([f45431e](https://github.com/ai-outfitter/pensieve/commit/f45431ede5093729e4a4cc7110a882e01863527b))
* **server:** read the record — payload bytes and a session index ([646f766](https://github.com/ai-outfitter/pensieve/commit/646f76640f25f2c9d67e31eb50fd75bca1907af2)), closes [#14](https://github.com/ai-outfitter/pensieve/issues/14)


### Bug Fixes

* **importer:** act on the adversarial review ([e493152](https://github.com/ai-outfitter/pensieve/commit/e4931520a8672fdf8e36d9a4228e407559ea2945)), closes [#14](https://github.com/ai-outfitter/pensieve/issues/14)
* **importer:** act on the second adversarial review ([b4e31a8](https://github.com/ai-outfitter/pensieve/commit/b4e31a81b8efd7d9cd85e2100c2e70a7c526ae5a))
* **server:** act on the read-path review ([3dd1b55](https://github.com/ai-outfitter/pensieve/commit/3dd1b55b30cb3e3738ba2dafec28e00716473654)), closes [#14](https://github.com/ai-outfitter/pensieve/issues/14)

## [0.4.0](https://github.com/ai-outfitter/pensieve/compare/v0.3.1...v0.4.0) (2026-08-13)


### Features

* triage issues with an agent resolved from the catalog ([#12](https://github.com/ai-outfitter/pensieve/issues/12)) ([9337073](https://github.com/ai-outfitter/pensieve/commit/93370734e70afab1fa1d33cc34d38832896672e0))


### Bug Fixes

* track the action's v1 tag instead of a commit ([#16](https://github.com/ai-outfitter/pensieve/issues/16)) ([3429772](https://github.com/ai-outfitter/pensieve/commit/3429772be1c21892274ebc0d5780e5f376d30e9a))

## [0.3.1](https://github.com/ai-outfitter/pensieve/compare/v0.3.0...v0.3.1) (2026-08-11)


### Bug Fixes

* **store:** send a checksum with object-lock PUTs ([#9](https://github.com/ai-outfitter/pensieve/issues/9)) ([b122349](https://github.com/ai-outfitter/pensieve/commit/b1223495f5829ae54a045919b0e3eef838b6356f))

## [0.3.0](https://github.com/ai-outfitter/pensieve/compare/v0.2.0...v0.3.0) (2026-08-11)


### Features

* **payloads:** presign direct uploads to the object store ([#5](https://github.com/ai-outfitter/pensieve/issues/5)) ([9821400](https://github.com/ai-outfitter/pensieve/commit/98214005c090958a40a585195ca7c5c44ffbcf31))
* **store:** authenticate to S3 with a projected web identity ([#8](https://github.com/ai-outfitter/pensieve/issues/8)) ([d965bc6](https://github.com/ai-outfitter/pensieve/commit/d965bc64e6a82f1d2f17b22876644555b5fcbb9c))

## [0.2.0](https://github.com/ai-outfitter/pensieve/compare/v0.1.0...v0.2.0) (2026-08-10)


### Features

* bun workspace, evidence sink, compose stack, and three system-scope collectors ([700f3ba](https://github.com/ai-outfitter/pensieve/commit/700f3ba43ce3604a3365482b5b6a42d3439156d8))


### Bug Fixes

* **collector-claude:** accept either post-tool result field name ([e72a288](https://github.com/ai-outfitter/pensieve/commit/e72a288733ccca695456eefc2eac196d3578609c))
* **collector-pi:** make the Pi collector run under Node ([#1](https://github.com/ai-outfitter/pensieve/issues/1)) ([299c2ae](https://github.com/ai-outfitter/pensieve/commit/299c2aeb070b619cefb7c20a089ec5ba3bbdb072))
* make the compose stack actually run end to end ([54ad4cd](https://github.com/ai-outfitter/pensieve/commit/54ad4cd84e559325a86a5afa2b6d6637a5d06830))
* **release:** grant actions scope to the caller workflow ([#3](https://github.com/ai-outfitter/pensieve/issues/3)) ([fd5dafd](https://github.com/ai-outfitter/pensieve/commit/fd5dafd0a4c47198241f4d302987c3f0e4dc4323))
