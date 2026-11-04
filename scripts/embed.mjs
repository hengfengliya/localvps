// 把 src/panel.html 连同 Beayy 设计系统的 CSS 内嵌成 TS 模块，node 与 bun 单文件版都能直接带上页面
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const { version } = JSON.parse(read("../package.json"));
fs.writeFileSync(
  new URL("../src/version.ts", import.meta.url),
  `// 由 scripts/embed.mjs 从 package.json 生成，勿手改\nexport const VERSION = ${JSON.stringify(version)};\n`,
);
const favicon = fs.readFileSync(new URL("../src/favicon.png", import.meta.url)).toString("base64");
const html = read("../src/panel.html")
  .replace("<!-- favicon -->", `<link rel="icon" type="image/png" href="data:image/png;base64,${favicon}">`)
  .replace(
    "<!-- beayy -->",
    `<style>\n${read("../src/vendor/beayy/tokens.css")}\n${read("../src/vendor/beayy/bundle.css")}\n</style>`,
  );
fs.writeFileSync(
  new URL("../src/panel-html.ts", import.meta.url),
  "// 由 scripts/embed.mjs 从 panel.html 生成，勿手改\nexport default " + JSON.stringify(html) + ";\n",
);
