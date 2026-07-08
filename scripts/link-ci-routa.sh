#!/usr/bin/env sh
set -eu

mkdir -p node_modules/.bin examples/basic-api/node_modules/.bin examples/full-api/node_modules/.bin
printf '%s\n' '#!/usr/bin/env sh' 'exec node "$GITHUB_WORKSPACE/packages/cli/dist/index.js" "$@"' > node_modules/.bin/routa
chmod +x node_modules/.bin/routa
cp node_modules/.bin/routa examples/basic-api/node_modules/.bin/routa
cp node_modules/.bin/routa examples/full-api/node_modules/.bin/routa
