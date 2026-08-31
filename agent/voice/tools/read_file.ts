import { disableTool } from "eve/tools"

// Voice has exactly three tools into Core plus load_skill (vision §10: the tool
// boundary is the seam, not the prompt). No shell, no filesystem, no network,
// no self-delegation.
export default disableTool()
