import fs from "node:fs";
import path from "node:path";

const SHOUT_PIPELINE = `name: shout
description: uppercase any text file (a hello-world you can run from your phone)
steps:
  - name: read
    run: ["cat", "{input}"]
  - name: shout
    run: ["tr", "a-z", "A-Z"]
`;

const WORDCOUNT_PIPELINE = `name: wordcount
description: count words in any text file
steps:
  - name: count
    run: ["wc", "-w", "{input}"]
`;

const AGENTS_README = `# Agents

Each subfolder with a \`.pipeline.yaml\` is a drop target: put a file in from
any of your devices, and the result appears beside it as \`<name>.result.md\`
(or \`<name>.error.md\` when something goes wrong — always in plain English).

Open a folder's \`.pipeline.yaml\` to see exactly what it runs before you drop
anything in. Steps declaring \`network: true\` may leave the machine; everything
else is local.
`;

export interface StarterResult {
  created: string[];
  skipped: string[];
}

/** Create Agents/ with starter pipelines. Never overwrites anything. */
export function createAgentsFolder(root: string): StarterResult {
  const created: string[] = [];
  const skipped: string[] = [];
  const write = (relPath: string, content: string) => {
    const full = path.join(root, relPath);
    if (fs.existsSync(full)) {
      skipped.push(relPath);
      return;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    created.push(relPath);
  };
  write("Agents/README.md", AGENTS_README);
  write("Agents/Shout/.pipeline.yaml", SHOUT_PIPELINE);
  write("Agents/Wordcount/.pipeline.yaml", WORDCOUNT_PIPELINE);
  return { created, skipped };
}
