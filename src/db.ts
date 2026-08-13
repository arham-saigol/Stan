import { sqlite } from "@flue/runtime/node";
import { statePaths } from "./state.ts";

export default sqlite(statePaths().flueDb);
