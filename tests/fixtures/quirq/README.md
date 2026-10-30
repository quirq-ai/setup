Synthetic quirq-ai files for step 3's tests. `tests/fake-gh/gh` serves the config files as GitHub's
contents API would, and `remotes.mjs` turns each folder into a local git repo that step 3 clones
(QQ_SETUP_GIT_BASE) instead of github.com. `tests/fake-python/python3` stands in for qqcfg and gate's
`settings plan`; the files it reads here only have to exist.
