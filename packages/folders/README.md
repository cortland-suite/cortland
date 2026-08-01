# honeycrisp-folders

**The filesystem is the interface.** Watched folders run declared pipelines:
drop a file in from any device that can reach the folder (iCloud Drive makes
that every Apple device), and the result appears beside it. No app, no UI, no
login.

```
Agents/
├── Shout/
│   ├── .pipeline.yaml        ← the folder documents itself
│   ├── hello.txt             ← you drop this
│   └── hello.txt.result.md   ← this appears
└── Wordcount/
    └── .pipeline.yaml
```

## Pipeline definition

```yaml
name: shout
description: uppercase any text file
steps:
  - name: read
    run: ["cat", "{input}"]     # argv array — never a shell string
  - name: shout
    run: ["tr", "a-z", "A-Z"]   # receives previous step's stdout on stdin
```

- `{input}` = the dropped file's absolute path; `{dir}` = the pipeline folder.
- Steps chain stdout → stdin; the last step's stdout becomes
  `<name>.result.md`, stamped with provenance.
- A step that talks to the network must declare `network: true` — the folder's
  contract is inspectable before you drop anything in it, and the declaration
  lands in the audit row.

## Failure is loud, silence is never the outcome

A failing step writes `<name>.error.md` beside the drop, in plain English:
which step, what happened, what to do. Every run — success or failure — writes
a row to the suite's shared audit DB.

## Running

```
honeycrisp-folders ~/Library/Mobile\ Documents/com~apple~CloudDocs/Agents
```

For always-on operation, install the launchd template in `launchd/`
(instructions inside). iCloud dataless files are requested for download
automatically (`brctl download`); processing starts when the bytes arrive.

## Trust model (v1)

Anyone who can write a folder's `.pipeline.yaml` decides what runs on drops
into that folder. Keep the watched root inside your own iCloud Drive (private
by default) and treat shared folders as untrusted. Command allowlisting /
pipeline pinning is on the roadmap.
