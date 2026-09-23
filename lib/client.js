window.__ModuleLoader__.load({
	id: "dsh-snapcompact",
	factory: (require) => {
		const React = require("react");
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		function apply(ctx) {
			// Client-side initialization for snapcompact
			const slots = ctx.get("slots");
			if (!slots) return;
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});
