import {cleanup, render, screen, waitFor} from "@testing-library/react";
import {userEvent} from "@testing-library/user-event";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ProviderSetup} from "./ProviderSetup.js";
import type {DesktopModelOption, DesktopOnboardingProvider, DesktopResult} from "../../../contracts.js";

afterEach(cleanup);
const provider: DesktopOnboardingProvider = {id:"deepseek",displayName:"DeepSeek",
  keyPlaceholder:"API Key", efforts:["off","low","high","max"],
  fallbackModelIds:["deepseek-flash","deepseek-v4-flash"], allowManualModel:false,
  allowCustomBaseUrl:false, credentialStatus:"available"};
function props(discover = vi.fn().mockResolvedValue({ok:true,value:[]})) {
  return {providers:[provider], busy:false, onDiscoverModels:discover,
    onTestModel:vi.fn(), onForgetCredential:vi.fn()};
}

describe("live model discovery", () => {
  it("rescans when returning to a provider after visiting one without credentials", async () => {
    const user = userEvent.setup();
    const discover=vi.fn().mockResolvedValue({ok:true,value:[
      {id:"deepseek-flash",displayName:"deepseek-flash",source:"live"},
    ]});
    render(<ProviderSetup {...props(discover)} providers={[provider,
      {...provider,id:"kimi-cn",displayName:"Kimi",credentialStatus:"missing"},
    ]} />);
    await waitFor(()=>expect(discover).toHaveBeenCalledTimes(1), {timeout:2000});
    await user.click(screen.getByRole("button",{name:"Kimi"}));
    await user.click(screen.getByRole("button",{name:"DeepSeek"}));
    await waitFor(()=>expect(discover).toHaveBeenCalledTimes(2), {timeout:2000});
    expect(screen.getByText(/实时列表/)).toBeTruthy();
  });

  it("manual refresh can repeat and keeps the user's draft selection", async () => {
    const user = userEvent.setup();
    const discover = vi.fn().mockResolvedValue({ok:true,value:[
      {id:"deepseek-flash",displayName:"deepseek-flash",source:"live"},
    ]});
    render(<ProviderSetup {...props(discover)} providers={[{...provider,credentialStatus:"missing"}]} />);
    await user.selectOptions(screen.getByLabelText("模型"), "deepseek-v4-flash");
    await user.click(screen.getByRole("button",{name:"刷新模型"}));
    await waitFor(()=>expect(discover).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button",{name:"刷新模型"}));
    await waitFor(()=>expect(discover).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText("模型") as HTMLSelectElement).value).toBe("deepseek-v4-flash");
    expect(screen.getByText(/当前选择不在本次列表中/)).toBeTruthy();
  });

  it("automatically scans saved credentials and preserves an existing model selection", async () => {
    const discover = vi.fn().mockResolvedValue({ok:true,value:[
      {id:"deepseek-new",displayName:"deepseek-new",source:"live"},
    ]});
    render(<ProviderSetup {...props(discover)} activeModel={{providerId:"deepseek",
      modelId:"deepseek-v4-flash",capability:"ready"}} />);
    await waitFor(()=>expect(discover).toHaveBeenCalledTimes(1), {timeout:2000});
    expect((screen.getByLabelText("模型") as HTMLSelectElement).value).toBe("deepseek-v4-flash");
    expect(await screen.findByText(/实时列表.*1/)).toBeTruthy();
    expect(screen.getByRole("option",{name:"deepseek-new"})).toBeTruthy();
  });

  it("labels fallback explicitly and does not scan without credentials", async () => {
    const user = userEvent.setup();
    const discover = vi.fn().mockResolvedValue({ok:true,value:[
      {id:"deepseek-flash",displayName:"deepseek-flash",source:"fallback"},
    ]});
    render(<ProviderSetup {...props(discover)} providers={[{...provider,credentialStatus:"missing"}]} />);
    expect(discover).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button",{name:"刷新模型"}));
    expect(await screen.findByText(/备用列表/)).toBeTruthy();
    expect(screen.queryByText(/实时列表/)).toBeNull();
  });

  it("a live empty list stays empty apart from the unchanged selection", async () => {
    render(<ProviderSetup {...props()} />);
    expect(await screen.findByText(/未返回可用模型/,{},{timeout:2000})).toBeTruthy();
    expect(screen.queryByRole("option",{name:"deepseek-v4-flash"})).toBeNull();
    expect((screen.getByLabelText("模型") as HTMLSelectElement).value).toBe("deepseek-flash");
  });

  it("ignores a response belonging to a previous provider", async () => {
    let finish!: (value:DesktopResult<readonly DesktopModelOption[]>)=>void;
    const discover = vi.fn().mockImplementation(()=>new Promise((resolve)=>{finish=resolve;}));
    const view=render(<ProviderSetup {...props(discover)} />);
    await waitFor(()=>expect(discover).toHaveBeenCalledTimes(1), {timeout:2000});
    view.rerender(<ProviderSetup {...props(discover)} providers={[
      {...provider,id:"kimi-cn",displayName:"Kimi",credentialStatus:"missing",fallbackModelIds:["kimi-default"]},
    ]} />);
    finish({ok:true,value:[{id:"wrong-provider-model",displayName:"wrong-provider-model",source:"live"}]});
    await waitFor(()=>expect((screen.getByLabelText("模型") as HTMLSelectElement).value).toBe("kimi-default"));
    expect(screen.queryByRole("option",{name:"wrong-provider-model"})).toBeNull();
  });
});
