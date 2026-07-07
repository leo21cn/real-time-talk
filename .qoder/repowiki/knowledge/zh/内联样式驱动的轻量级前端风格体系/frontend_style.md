该仓库的前端位于 `client/` 目录，基于 React + Vite + TypeScript 构建，采用**纯内联样式（inline style）**的极简风格方案，未引入任何 CSS 框架或样式库。

1. **系统/方法**：不使用 CSS 文件、SCSS、Tailwind、styled-components 等外部样式依赖。所有视觉表现通过 JSX 中的 `style={{ ... }}` 对象直接声明，属于最轻量的“零依赖”样式策略。
2. **关键文件**：
   - `client/src/App.tsx` — 主应用布局与全局容器样式
   - `client/src/components/AdminPage.tsx` — 管理后台页面，集中了大量内联样式定义（背景色 `#F5F5F5`、卡片白底 `#FFF`、边框 `#e8e8e8`、文字色 `#1a1a1a` / `#333` / `#666` / `#999` 等）
   - `client/src/components/ChatPanel.tsx`、`ChatBubble.tsx`、`SpeechBubble.tsx`、`ErrorBubble.tsx`、`InputBox.tsx`、`AvatarView.tsx`、`KnowledgePanel.tsx` — 各功能组件各自维护自身内联样式
   - `client/package.json` — 确认无 CSS 相关依赖（仅 react、react-dom、marked）
3. **架构与约定**：
   - 每个组件自包含其样式，不存在跨组件共享的样式变量或主题文件
   - 颜色值以硬编码十六进制形式散落各处（如 `#F5F5F5`、`#FFF`、`#1a1a1a`、`#333`、`#666`、`#999`、`#e8e8e8`），缺乏统一设计令牌
   - 布局主要使用 Flexbox（`display: 'flex'`、`flexDirection: 'column'`、`gap`、`flex: 1` 等）
   - 字体大小、字重、边距均以像素值硬编码，无响应式断点或媒体查询
4. **开发者应遵循的规则**：
   - 如需新增样式，直接在对应组件的 `style={{}}` 中追加；当前仓库未提供集中样式入口
   - 建议逐步抽取重复的颜色、字号、间距为常量（可在 `src/types/` 下新建 `theme.ts` 存放），避免散落的魔法数字
   - 若后续需要主题切换或响应式适配，可考虑迁移至 CSS-in-JS（如 emotion/styled-components）或 Tailwind，但需评估对现有内联样式的重构成本