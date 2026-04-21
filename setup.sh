#!/usr/bin/env bash
set -e

# 1. 安装 bun（如果没有）
if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  # source profile in case bun installer wrote there
  [ -f "$HOME/.bun/bin/bun" ] && export BUN_INSTALL="$HOME/.bun"
fi

# 2. 安装依赖
echo "Installing dependencies..."
bun install

# 3. 创建 .env（如果不存在）
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "Created .env — please fill in your API keys:"
  echo "  → ANTHROPIC_API_KEY (required)"
  echo "  → TWITTER_API_KEY (optional, for politics market analysis)"
  echo ""
fi

# 4. 启动
echo "Starting dev server..."
exec bun run dev
