#!/usr/bin/env bash
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli="$repo_root/packages/cli/dist/index.js"

if [[ ! -f "$cli" ]]; then
	echo "Missing built CLI at $cli"
	echo "Run: pnpm build"
	exit 1
fi

tmp_root="${TMPDIR:-/tmp}/routa-scaffold-errors-$$"
mkdir -p "$tmp_root"

cleanup() {
	rm -rf "$tmp_root"
}
trap cleanup EXIT

create_project() {
	local dir="$1"
	mkdir -p "$dir/src"
	cat > "$dir/package.json" <<'JSON'
{
	"type": "module",
	"dependencies": {
		"@routa-ts/core": "workspace:*",
		"zod": "^4.4.3"
	},
	"devDependencies": {
		"typescript": "^6.0.3"
	}
}
JSON
	cat > "$dir/tsconfig.json" <<'JSON'
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"strict": true,
		"skipLibCheck": true
	},
	"include": ["src/**/*.ts", ".routa/**/*.ts"]
}
JSON
	cat > "$dir/src/routa.ts" <<'TS'
import { createRouta } from "@routa-ts/core";

export default createRouta({
	port: 3000,
});
TS
}

write_base() {
	local file="$1"
	cat > "$file" <<'YAML'
openapi: 3.1.0
info:
  title: Error Smoke API
  version: 0.0.0
paths:
YAML
}

run_case() {
	local name="$1"
	local input="$2"
	local setup="$3"
	local dir="$tmp_root/$name"
	mkdir -p "$dir"
	create_project "$dir"

	if [[ -n "$setup" ]]; then
		eval "$setup"
	fi

	echo
	echo "================================================================================"
	echo "$name"
	echo "command: routa scaffold $input"
	echo "--------------------------------------------------------------------------------"
	(
		cd "$dir"
		node "$cli" scaffold "$input"
	)
}

run_case "ROUTA_OPENAPI_FILE_NOT_FOUND" "missing.yaml" ""

run_case "ROUTA_OPENAPI_UNSUPPORTED_EXTENSION" "openapi.txt" \
	"echo 'not openapi' > \"\$dir/openapi.txt\""

run_case "ROUTA_OPENAPI_PARSE_ERROR_YAML" "openapi.yaml" \
	"printf 'openapi: [\n' > \"\$dir/openapi.yaml\""

run_case "ROUTA_OPENAPI_PARSE_ERROR_JSON" "openapi.json" \
	"printf '{\"openapi\":' > \"\$dir/openapi.json\""

run_case "ROUTA_OPENAPI_MISSING_PATHS_FRAGMENT_AT_ROOT" "openapi.yaml" \
	"cat > \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
YAML"

run_case "ROUTA_OPENAPI_INVALID_PATHS" "openapi.yaml" \
	"cat > \"\$dir/openapi.yaml\" <<'YAML'
openapi: 3.1.0
info:
  title: Error Smoke API
  version: 0.0.0
paths: []
YAML"

run_case "ROUTA_OPENAPI_MISSING_OPENAPI_VERSION" "openapi.yaml" \
	"cat > \"\$dir/openapi.yaml\" <<'YAML'
info:
  title: Error Smoke API
  version: 0.0.0
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
YAML"

run_case "ROUTA_OPENAPI_MISSING_INFO" "openapi.yaml" \
	"cat > \"\$dir/openapi.yaml\" <<'YAML'
openapi: 3.1.0
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
YAML"

run_case "ROUTA_OPENAPI_INVALID_PATH_KEY" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
YAML"

run_case "ROUTA_OPENAPI_UNSUPPORTED_METHOD_UPPERCASE" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    GET:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
YAML"

run_case "ROUTA_OPENAPI_UNSUPPORTED_METHOD_TYPO" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    gets:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
YAML"

run_case "ROUTA_OPENAPI_INVALID_OPERATION" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get: listUsers
YAML"

run_case "ROUTA_OPENAPI_MISSING_OPERATION_ID" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      responses:
        \"200\":
          description: Users
YAML"

run_case "ROUTA_OPENAPI_DUPLICATE_OPERATION_ID" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: users
      responses:
        \"200\":
          description: Users
  /admins:
    get:
      operationId: users
      responses:
        \"200\":
          description: Admins
YAML"

run_case "ROUTA_OPENAPI_INVALID_TYPESCRIPT_IDENTIFIER" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
          content:
            application/json:
              schema:
                \$ref: \"#/components/schemas/123 bad name\"
components:
  schemas:
    \"123 bad name\":
      type: object
YAML"

run_case "ROUTA_OPENAPI_MISSING_RESPONSES" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
YAML"

run_case "ROUTA_OPENAPI_INVALID_RESPONSE_STATUS" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      responses:
        default:
          description: Users
YAML"

run_case "ROUTA_OPENAPI_MISSING_PATH_PARAMETER" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users/{id}:
    get:
      operationId: getUser
      responses:
        \"200\":
          description: User
YAML"

run_case "ROUTA_OPENAPI_UNUSED_PATH_PARAMETER" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        \"200\":
          description: Users
YAML"

run_case "ROUTA_OPENAPI_INVALID_REQUEST_BODY" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    post:
      operationId: createUser
      requestBody:
        content: []
      responses:
        \"201\":
          description: Created
YAML"

run_case "ROUTA_OPENAPI_UNSUPPORTED_REQUEST_MEDIA_TYPE" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    post:
      operationId: createUser
      requestBody:
        content:
          text/plain:
            schema:
              type: string
      responses:
        \"201\":
          description: Created
YAML"

run_case "ROUTA_OPENAPI_GET_BODY_UNSUPPORTED" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses:
        \"200\":
          description: Users
YAML"

run_case "ROUTA_OPENAPI_INVALID_RESPONSE_CONTENT" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
          content: []
YAML"

run_case "ROUTA_OPENAPI_UNSUPPORTED_RESPONSE_MEDIA_TYPE" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
          content:
            text/plain:
              schema:
                type: string
YAML"

run_case "ROUTA_OPENAPI_UNSUPPORTED_SCHEMA_COMPOSED" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
          content:
            application/json:
              schema:
                oneOf:
                  - type: string
YAML"

run_case "ROUTA_OPENAPI_UNSUPPORTED_SCHEMA_OPTION" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
          content:
            application/json:
              schema:
                type: object
                additionalProperties:
                  type: string
YAML"

run_case "ROUTA_OPENAPI_MISSING_REF" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
          content:
            application/json:
              schema:
                \$ref: \"#/components/schemas/MissingUser\"
YAML"

run_case "ROUTA_OPENAPI_UNSUPPORTED_REF" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
          content:
            application/json:
              schema:
                \$ref: \"./schemas.yaml#/User\"
YAML"

run_case "ROUTA_OPENAPI_NO_SUPPORTED_OPERATIONS" "openapi.yaml" \
	"write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    parameters: []
YAML"

run_case "ROUTA_SCAFFOLD_UNMANAGED_FILE" "openapi.yaml" \
	"mkdir -p \"\$dir/src/routes/users\"
echo 'export default {};' > \"\$dir/src/routes/users/route.ts\"
write_base \"\$dir/openapi.yaml\"
cat >> \"\$dir/openapi.yaml\" <<'YAML'
  /users:
    get:
      operationId: listUsers
      responses:
        \"200\":
          description: Users
YAML"

echo
echo "================================================================================"
echo "done"
echo "Temp projects were removed."
