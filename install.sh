#!/bin/bash

# watch-llama Installer
# Ported from watch-ollama workflow

set -e

PROJECT_ROOT="$(dirname "$(readlink -f "$0")")"
INSTALL_DIR="$HOME/.watch-llama/bin"
ALIAS_MARKER_START="# watch-llama: aliases"
ALIAS_MARKER_END="# watch-llama: aliases-end"

echo "=== watch-llama Installer ==="

# 1. Build project
echo "Step 1: Building project..."
cd "$PROJECT_ROOT"
npm install
npm run build

# 2. Setup bin directory
echo "Step 2: Setting up bin directory..."
mkdir -p "$INSTALL_DIR"

# 3. Create wrapper scripts
echo "Step 3: Creating wrapper scripts..."
cat <<EOF > "$INSTALL_DIR/watch-llama"
#!/bin/bash
node --no-deprecation "$PROJECT_ROOT/dist/src/bin/watch-llama.js" "\$@"
EOF

cat <<EOF > "$INSTALL_DIR/llama-watch-readlog"
#!/bin/bash
node --no-deprecation "$PROJECT_ROOT/dist/src/bin/llama-watch-readlog.js" "\$@"
EOF

cat <<EOF > "$INSTALL_DIR/llama-report"
#!/bin/bash
node --no-deprecation "$PROJECT_ROOT/dist/src/bin/llama-report.js" "\$@"
EOF

cat <<EOF > "$INSTALL_DIR/llama-stats"
#!/bin/bash
node --no-deprecation "$PROJECT_ROOT/dist/src/bin/llama-stats.js" "\$@"
EOF

chmod +x "$INSTALL_DIR"/*

# 4. Add aliases
add_aliases() {
    local rc_file="$1"
    [ ! -f "$rc_file" ] && return

    # Remove existing alias block
    if grep -qF "$ALIAS_MARKER_START" "$rc_file" 2>/dev/null; then
        sed -i "/$ALIAS_MARKER_START/,/$ALIAS_MARKER_END/d" "$rc_file"
    fi

    echo "Adding aliases to $rc_file..."
    {
        echo ""
        echo "$ALIAS_MARKER_START"
        echo "alias watch-llama='$INSTALL_DIR/watch-llama'"
        echo "alias llama-watch-readlog='$INSTALL_DIR/llama-watch-readlog'"
        echo "alias llama-report='$INSTALL_DIR/llama-report'"
        echo "alias llama-stats='$INSTALL_DIR/llama-stats'"
        echo "$ALIAS_MARKER_END"
    } >> "$rc_file"
}

add_aliases "$HOME/.zshrc"
add_aliases "$HOME/.bashrc"

echo "Step 4: Installation complete!"
echo "Please restart your shell or run: source ~/.zshrc (or ~/.bashrc)"
