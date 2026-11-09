# Attribution and scope

OpenFilm Harness is an independent integration prototype. It is not an official OpenFilm or Harness vendor product.

It uses the unmodified MIT-licensed OpenFilm 0.2.7 runtime and Studio, supplied by the pinned `openfilm` npm dependency. Original OpenFilm copyrights, license, trademark policy and third-party notices remain inside that dependency. The editor host contract and same-process edit queue are reused; no code from the researched DesireCore, Cutline, ChatCut or other integrations is copied.

The included OpenFilm runtime, MCP SDK, Zod and transitive dependencies keep their own licenses. Browser binaries and FFmpeg are not bundled. Installing a plugin does not supply those dependencies, a model account, or media-generation credits.

The plugin does not read other Harness chat histories, start a model session, or send chat messages. A host browser pane can show the editor when available; other clients use a normal browser. Native plugin manifests/configurations are adapters around one stdio MCP server, not evidence that every host UI has been tested.
