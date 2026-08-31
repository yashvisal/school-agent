import { disableTool } from "eve/tools"

// No subagent delegation from the workspace agent: a child would inherit this
// agent's tools and sandbox, which widens the seam for no benefit here.
export default disableTool()
