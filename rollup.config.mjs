import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";

export default {
	input: "src/plugin.js",
	output: {
		file: "com.coreloop.t3.sdPlugin/bin/plugin.js",
		format: "es",
		sourcemap: false,
	},
	external: (id) => id.startsWith("node:"),
	plugins: [nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }), commonjs()],
	onwarn(w, warn) {
		if (w.code === "CIRCULAR_DEPENDENCY" || w.code === "THIS_IS_UNDEFINED") return;
		warn(w);
	},
};
