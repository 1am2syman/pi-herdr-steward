# Ship a Pi package for Pi agents

The first version is distributed as a reusable Pi package and creates only Pi agents through Herdr. Restricting the initial agent kind preserves known session, model, tool, and reporting behavior, while project-local state keeps Runs inspectable; support for other Herdr agent kinds remains a future extension rather than a compatibility promise in version one.
