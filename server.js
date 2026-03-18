import { createRequire } from "module";
const require = createRequire(import.meta.url);
process.env.NODE_ENV = "production";
require("./dist/index.cjs");
