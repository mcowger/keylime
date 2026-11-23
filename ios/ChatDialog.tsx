import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { parseDocument, DomUtils } from "htmlparser2";
import type { ChildNode } from "domhandler";
import {
  ActivityIndicator,
  DynamicColorIOS,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ChatDialogRequest, ChatDialogValue } from "./useChatSession";
import { dynamicTheme as theme } from "./dynamic-theme";

type DialogProps = {
  request: ChatDialogRequest | null;
  onRespond(value?: ChatDialogValue): Promise<void>;
  submitting?: boolean;
  error?: string | null;
};
type AskDraft = { selected: string[]; other: string; otherChosen: boolean };
type FormValue = string | string[];
type FormControl = {
  key: string;
  tag: "input" | "textarea" | "select";
  type: string;
  name: string;
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  required: boolean;
  checked: boolean;
  multiple: boolean;
  min?: string;
  max?: string;
  step?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  options: {
    label: string;
    value: string;
    selected: boolean;
    disabled: boolean;
  }[];
};
type FormRow =
  | { kind: "text"; key: string; text: string }
  | { kind: "control"; control: FormControl };
type FormModel = {
  rows: FormRow[];
  controls: FormControl[];
  otherGroups: Set<string>;
};
const dropped: Record<string, true> = {
  script: true,
  style: true,
  template: true,
  noscript: true,
  button: true,
  iframe: true,
  object: true,
  embed: true,
  img: true,
  svg: true,
  math: true,
};
const choiceTypes: Record<string, true> = { radio: true, checkbox: true };
const inputTypes: Record<string, true> = {
  radio: true,
  checkbox: true,
  text: true,
  number: true,
  range: true,
  email: true,
  url: true,
  tel: true,
  search: true,
  date: true,
  time: true,
  hidden: true,
};

function formModel(html: string): FormModel {
  const document = parseDocument(html);
  const roots = DomUtils.findAll(
    (element) => element.name === "form",
    document.children,
  );
  const root = roots[0] ?? document;
  const elements = DomUtils.findAll(
    (element) => !dropped[element.name],
    root.children,
  );
  const labels = new Map<string, string>();
  for (const element of elements)
    if (element.name === "label" && element.attribs.for)
      labels.set(element.attribs.for, DomUtils.textContent(element).trim());
  const rows: FormRow[] = [];
  const controls: FormControl[] = [];
  let nextKey = 0;
  function visit(node: ChildNode, parentLabel = "") {
    if (node.type === "text") {
      const text = node.data.trim();
      if (text && !parentLabel)
        rows.push({ kind: "text", key: `t${nextKey++}`, text });
      return;
    }
    if (node.type !== "tag") return;
    const tag = node.name;
    if (dropped[tag]) return;
    const a = node.attribs;
    if (tag === "label") {
      const containsControl = DomUtils.findOne(
        (item) =>
          item.name === "input" ||
          item.name === "select" ||
          item.name === "textarea",
        node.children,
        true,
      );
      if (containsControl) {
        const label = DomUtils.textContent(node).trim();
        for (const child of node.children) visit(child, label);
      } else if (!a.for)
        for (const child of node.children) visit(child, parentLabel);
      return;
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const rawType = (a.type ?? "text").toLowerCase();
      const type =
        tag === "input" ? (inputTypes[rawType] ? rawType : "text") : tag;
      const options =
        tag === "select"
          ? DomUtils.findAll(
              (item) => item.name === "option",
              node.children,
            ).map((option) => ({
              label: DomUtils.textContent(option).trim(),
              value:
                option.attribs.value ?? DomUtils.textContent(option).trim(),
              selected: "selected" in option.attribs,
              disabled:
                "disabled" in option.attribs ||
                (option.parent?.type === "tag" &&
                  option.parent.name === "optgroup" &&
                  "disabled" in option.parent.attribs),
            }))
          : [];
      const length = (name: string) =>
        a[name] === undefined ? undefined : Number(a[name]);
      const control: FormControl = {
        key: `c${nextKey++}`,
        tag,
        type,
        name: a.name ?? "",
        label: parentLabel || labels.get(a.id ?? "") || a["aria-label"] || "",
        value:
          tag === "textarea"
            ? DomUtils.textContent(node)
            : (a.value ?? (choiceTypes[type] ? "on" : "")),
        placeholder: a.placeholder ?? "",
        disabled: "disabled" in a,
        required: "required" in a,
        checked: "checked" in a,
        multiple: "multiple" in a,
        min: a.min,
        max: a.max,
        step: a.step,
        pattern: a.pattern,
        minLength: length("minlength"),
        maxLength: length("maxlength"),
        options,
      };
      controls.push(control);
      rows.push({ kind: "control", control });
      return;
    }
    for (const child of node.children) visit(child, parentLabel);
  }
  for (const child of root.children) visit(child);
  const groups = new Map<string, FormControl[]>();
  for (const control of controls)
    if (control.name && choiceTypes[control.type]) {
      const id = `${control.type}\0${control.name}`;
      groups.set(id, [...(groups.get(id) ?? []), control]);
    }
  const otherGroups = new Set<string>();
  for (const [id, group] of groups)
    if (
      group.length >= 2 &&
      !group.some((control) => /^\s*other\b/i.test(control.label))
    )
      otherGroups.add(id);
  return { rows, controls, otherGroups };
}

function initialForm(model: FormModel): Record<string, FormValue> {
  const values: Record<string, FormValue> = Object.create(null);
  for (const control of model.controls) {
    if (control.disabled) continue;
    const name = control.name || control.key;
    if (control.type === "checkbox") {
      const selected = Array.isArray(values[name]) ? values[name] : [];
      values[name] = control.checked ? [...selected, control.value] : selected;
    } else if (control.type === "radio") {
      if (control.checked) values[name] = control.value;
    } else if (control.tag === "select") {
      const selected = control.options
        .filter((option) => option.selected && !option.disabled)
        .map((option) => option.value);
      values[name] = control.multiple
        ? selected
        : (selected[0] ??
          control.options.find((option) => !option.disabled)?.value ??
          "");
    } else values[name] = control.value;
  }
  return values;
}

function formResult(
  model: FormModel,
  values: Record<string, FormValue>,
  others: Record<string, string>,
): { data: Record<string, string | number | string[]>; error: string | null } {
  const data: Record<string, string | number | string[]> = Object.create(null);
  const handled = new Set<string>();
  for (const control of model.controls) {
    const { type } = control;
    const name = control.name || control.key;
    if (control.disabled || handled.has(name)) continue;
    handled.add(name);
    const group = control.name
      ? model.controls.filter(
          (item) => item.name === name && item.type === type && !item.disabled,
        )
      : [control];
    const other = (others[`${type}\0${name}`] ?? "").trim();
    const value = values[name];
    if (type === "checkbox" || type === "radio") {
      const selected = Array.isArray(value) ? value : value ? [value] : [];
      const combined = other ? [...selected, other] : selected;
      if (group.some((item) => item.required) && !combined.length)
        return {
          data,
          error: `Select an answer for ${control.label || name}.`,
        };
      if (control.name && type === "checkbox" && group.length > 1)
        data[name] = combined;
      else if (control.name && combined[0] !== undefined)
        data[name] = combined[0];
      continue;
    }
    if (control.tag === "select" && control.multiple) {
      const selected = Array.isArray(value) ? value : [];
      if (control.required && selected.length === 0)
        return {
          data,
          error: `Select an answer for ${control.label || name}.`,
        };
      if (control.name) data[name] = selected;
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (control.required && !text.trim())
      return { data, error: `${control.label || name} is required.` };
    if (
      (text &&
        control.minLength !== undefined &&
        text.length < control.minLength) ||
      (control.maxLength !== undefined && text.length > control.maxLength)
    )
      return { data, error: `Check the length of ${control.label || name}.` };
    if (text && control.pattern) {
      try {
        if (!new RegExp(`^(?:${control.pattern})$`).test(text))
          return { data, error: `Check ${control.label || name}.` };
      } catch {
        /* Invalid HTML patterns are ignored by browsers. */
      }
    }
    if (text && type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
      return {
        data,
        error: `Enter a valid email for ${control.label || name}.`,
      };
    if (text && type === "url") {
      try {
        new URL(text);
      } catch {
        return {
          data,
          error: `Enter a valid URL for ${control.label || name}.`,
        };
      }
    }
    if (text && (type === "number" || type === "range")) {
      const number = Number(text);
      if (
        !Number.isFinite(number) ||
        (control.min !== undefined && number < Number(control.min)) ||
        (control.max !== undefined && number > Number(control.max))
      )
        return {
          data,
          error: `Enter a valid number for ${control.label || name}.`,
        };
      if (control.name) data[name] = number;
    } else if (control.name) data[name] = text;
  }
  return { data, error: null };
}

function Choice({
  label,
  description,
  checked,
  onPress,
  disabled,
}: {
  label: string;
  description?: string;
  checked?: boolean;
  onPress(): void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: !!checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.choice, checked && styles.choiceSelected]}
    >
      <Text style={styles.choiceText}>
        {checked ? "●  " : "○  "}
        {label}
      </Text>
      {description ? <Text style={styles.dim}>{description}</Text> : null}
    </Pressable>
  );
}

function FormDialog({
  html,
  disabled,
  onSubmit,
  submitRef,
}: {
  html: string;
  disabled: boolean;
  onSubmit(value: ChatDialogValue): void;
  submitRef: RefObject<(() => void) | null>;
}) {
  const model = useMemo(() => formModel(html), [html]);
  const [values, setValues] = useState(() => initialForm(model));
  const [others, setOthers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const update = (name: string, value: FormValue) => {
    setValues((current) =>
      Object.assign(Object.create(null), current, { [name]: value }),
    );
    setError(null);
  };
  const submit = () => {
    const result = formResult(model, values, others);
    if (result.error) setError(result.error);
    else onSubmit({ data: result.data });
  };
  useEffect(() => {
    submitRef.current = submit;
    return () => {
      submitRef.current = null;
    };
  });
  return (
    <>
      {model.rows.map((row) => {
        if (row.kind === "text")
          return (
            <Text key={row.key} style={styles.text}>
              {row.text}
            </Text>
          );
        const c = row.control;
        if (c.type === "hidden") return null;
        const name = c.name || c.key;
        const value = values[name];
        const groupId = `${c.type}\0${c.name}`;
        const group = model.controls.filter(
          (item) => item.name === c.name && item.type === c.type,
        );
        const showOther =
          model.otherGroups.has(groupId) && group[group.length - 1] === c;
        if (c.type === "checkbox" || c.type === "radio") {
          const selected = Array.isArray(value)
            ? value.includes(c.value)
            : value === c.value;
          return (
            <View key={c.key}>
              <Choice
                label={c.label || c.value}
                checked={selected}
                disabled={disabled || c.disabled}
                onPress={() => {
                  if (c.type === "radio") {
                    update(name, c.value);
                    setOthers((current) => ({ ...current, [groupId]: "" }));
                  } else {
                    const selectedValues = Array.isArray(value) ? value : [];
                    update(
                      name,
                      selected
                        ? selectedValues.filter((item) => item !== c.value)
                        : [...selectedValues, c.value],
                    );
                  }
                }}
              />
              {showOther ? (
                <TextInput
                  accessibilityLabel={`Other ${c.name}`}
                  editable={!disabled}
                  style={styles.input}
                  placeholder="Other"
                  placeholderTextColor={theme.muted}
                  value={others[groupId] ?? ""}
                  onChangeText={(text) => {
                    setOthers((current) => ({ ...current, [groupId]: text }));
                    if (c.type === "radio" && text.trim()) update(name, "");
                    setError(null);
                  }}
                />
              ) : null}
            </View>
          );
        }
        if (c.tag === "select")
          return (
            <View key={c.key} style={styles.field}>
              {c.label ? <Text style={styles.text}>{c.label}</Text> : null}
              {c.options.map((option, index) => {
                const selected = Array.isArray(value)
                  ? value.includes(option.value)
                  : value === option.value;
                return (
                  <Choice
                    key={`${option.value}-${index}`}
                    label={option.label}
                    checked={selected}
                    disabled={disabled || c.disabled || option.disabled}
                    onPress={() => {
                      if (!c.multiple) update(name, option.value);
                      else {
                        const selectedValues = Array.isArray(value)
                          ? value
                          : [];
                        update(
                          name,
                          selected
                            ? selectedValues.filter(
                                (item) => item !== option.value,
                              )
                            : [...selectedValues, option.value],
                        );
                      }
                    }}
                  />
                );
              })}
            </View>
          );
        return (
          <View key={c.key} style={styles.field}>
            {c.label ? <Text style={styles.text}>{c.label}</Text> : null}
            <TextInput
              accessibilityLabel={c.label || c.name || c.placeholder || "Input"}
              editable={!disabled && !c.disabled}
              value={typeof value === "string" ? value : ""}
              onChangeText={(text) => update(name, text)}
              placeholder={c.placeholder}
              placeholderTextColor={theme.muted}
              multiline={c.tag === "textarea"}
              maxLength={c.maxLength}
              keyboardType={
                c.type === "number" || c.type === "range"
                  ? "decimal-pad"
                  : c.type === "email"
                    ? "email-address"
                    : c.type === "url"
                      ? "url"
                      : c.type === "tel"
                        ? "phone-pad"
                        : "default"
              }
              style={[styles.input, c.tag === "textarea" && styles.multiline]}
            />
          </View>
        );
      })}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </>
  );
}

function DialogBody({
  request,
  onRespond,
  submitting = false,
  error,
}: Omit<DialogProps, "request"> & { request: ChatDialogRequest }) {
  const [value, setValue] = useState(
    request.method === "editor" ? (request.args[1] ?? "") : "",
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const formSubmit = useRef<(() => void) | null>(null);
  const [drafts, setDrafts] = useState<AskDraft[]>(() =>
    request.method === "askDialog"
      ? request.args[0].map((question) => ({
          selected:
            !question.multi &&
            question.recommended !== undefined &&
            question.options[question.recommended]
              ? [question.options[question.recommended].label]
              : [],
          other: "",
          otherChosen: false,
        }))
      : [],
  );
  const respond = (answer?: ChatDialogValue) => {
    void onRespond(answer).catch(() => {});
  };
  const title =
    request.method === "askDialog" || request.method === "formDialog"
      ? "Question"
      : request.method === "approve"
        ? request.args[0].full.split("\n")[0]
        : request.args[0];
  const updateDraft = (index: number, patch: Partial<AskDraft>) =>
    setDrafts((current) =>
      current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)),
    );
  const canAsk =
    request.method !== "askDialog" ||
    request.args[0].every(
      (question, index) =>
        question.multi ||
        drafts[index]?.selected.length ||
        (drafts[index]?.otherChosen && drafts[index]?.other.trim()),
    );
  const submit = () => {
    switch (request.method) {
      case "confirm":
        respond(true);
        break;
      case "input":
      case "editor":
        respond(value);
        break;
      case "select":
        if (selected !== null) respond(selected);
        break;
      case "askDialog":
        if (!canAsk) return;
        respond({
          kind: "submit",
          results: request.args[0].map((question, index) => {
            const draft = drafts[index];
            const options = question.options.map((option) => option.label);
            const customInput = draft.otherChosen ? draft.other.trim() : "";
            return {
              id: question.id,
              question: question.question,
              options,
              multi: question.multi ?? false,
              selectedOptions: options.filter((label) =>
                draft.selected.includes(label),
              ),
              ...(customInput ? { customInput } : {}),
            };
          }),
        });
        break;
    }
  };
  const secret =
    request.method === "input" &&
    (request.args[2]?.secret === true ||
      (request.args[2]?.secret !== false &&
        /password|secret|token|api.?key|credential/i.test(
          `${request.args[0]} ${request.args[1] ?? ""}`,
        )));
  return (
    <View style={styles.panel} accessibilityViewIsModal={false}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.dim}>Extension request</Text>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={styles.scroll}
        contentContainerStyle={styles.body}
      >
        {request.method === "confirm" ? (
          <Text style={styles.text}>{request.args[1]}</Text>
        ) : null}
        {request.method === "approve" ? (
          <>
            <Text style={styles.monospace}>
              {request.args[0].full.split("\n").slice(1).join("\n")}
            </Text>
            <Choice
              label="Allow"
              disabled={submitting}
              onPress={() => respond("once")}
            />
            {request.args[0].session ? (
              <Choice
                label={request.args[0].session}
                disabled={submitting}
                onPress={() => respond("session")}
              />
            ) : null}
            {request.args[0].grants?.map((grant, index) => (
              <View key={`${grant.scope}-${index}`}>
                <Choice
                  label={grant.label}
                  disabled={submitting}
                  onPress={() => respond({ grant: grant.scope, always: false })}
                />
                <Choice
                  label={grant.alwaysLabel}
                  disabled={submitting}
                  onPress={() => respond({ grant: grant.scope, always: true })}
                />
              </View>
            ))}
            <Choice
              label="Deny"
              disabled={submitting}
              onPress={() => respond("deny")}
            />
          </>
        ) : null}
        {request.method === "select"
          ? request.args[1].map((item, index) => {
              const label = typeof item === "string" ? item : item.label;
              const options = request.args[2];
              const checkbox =
                options?.selectionMarker === "checkbox" &&
                index < (options.markableCount ?? request.args[1].length);
              const checked = checkbox
                ? !!options?.checkedIndices?.includes(index)
                : selected === label;
              return (
                <Choice
                  key={`${label}-${index}`}
                  label={label}
                  description={
                    typeof item === "string" ? undefined : item.description
                  }
                  checked={checked}
                  disabled={submitting}
                  onPress={() =>
                    checkbox ? respond(label) : setSelected(label)
                  }
                />
              );
            })
          : null}
        {request.method === "input" || request.method === "editor" ? (
          <View style={styles.field}>
            <TextInput
              accessibilityLabel={request.args[0] || "Input value"}
              editable={!submitting}
              value={value}
              onChangeText={setValue}
              placeholder={
                request.method === "input" ? (request.args[1] ?? "") : ""
              }
              placeholderTextColor={theme.muted}
              secureTextEntry={!!secret && !showSecret}
              multiline={request.method === "editor"}
              style={[
                styles.input,
                request.method === "editor" && styles.multiline,
              ]}
            />
            {secret ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setShowSecret(!showSecret)}
              >
                <Text style={styles.dim}>{showSecret ? "Hide" : "Show"}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {request.method === "askDialog"
          ? request.args[0].map((question, index) => {
              const draft = drafts[index];
              return (
                <View key={`${question.id}-${index}`} style={styles.question}>
                  {question.header ? (
                    <Text style={styles.dim}>{question.header}</Text>
                  ) : null}
                  <Text style={styles.text}>{question.question}</Text>
                  {question.options.map((option, optionIndex) => {
                    const checked = draft.selected.includes(option.label);
                    return (
                      <Choice
                        key={`${option.label}-${optionIndex}`}
                        label={option.label}
                        description={
                          [
                            option.description,
                            checked ? option.preview : undefined,
                          ]
                            .filter(Boolean)
                            .join("\n") || undefined
                        }
                        checked={checked}
                        disabled={submitting}
                        onPress={() =>
                          updateDraft(index, {
                            selected: question.multi
                              ? checked
                                ? draft.selected.filter(
                                    (item) => item !== option.label,
                                  )
                                : [...draft.selected, option.label]
                              : [option.label],
                            otherChosen: question.multi
                              ? draft.otherChosen
                              : false,
                          })
                        }
                      />
                    );
                  })}
                  <Choice
                    label="Other"
                    checked={draft.otherChosen}
                    disabled={submitting}
                    onPress={() =>
                      updateDraft(index, {
                        otherChosen: !draft.otherChosen,
                        selected:
                          !draft.otherChosen && !question.multi
                            ? []
                            : draft.selected,
                      })
                    }
                  />
                  <TextInput
                    accessibilityLabel={`Other answer for ${question.question}`}
                    editable={!submitting}
                    value={draft.other}
                    onFocus={() => {
                      if (draft.other.trim())
                        updateDraft(index, {
                          otherChosen: true,
                          selected: question.multi ? draft.selected : [],
                        });
                    }}
                    onChangeText={(text) =>
                      updateDraft(index, {
                        other: text,
                        otherChosen: !!text.trim(),
                        selected:
                          text.trim() && !question.multi ? [] : draft.selected,
                      })
                    }
                    placeholder="Other"
                    placeholderTextColor={theme.muted}
                    multiline
                    style={styles.input}
                  />
                </View>
              );
            })
          : null}
        {request.method === "formDialog" ? (
          <FormDialog
            html={request.args[0]}
            disabled={submitting}
            onSubmit={respond}
            submitRef={formSubmit}
          />
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        {submitting ? <ActivityIndicator color={theme.muted} /> : null}
        <Pressable
          accessibilityRole="button"
          disabled={submitting}
          onPress={() => respond()}
          style={styles.button}
        >
          <Text style={styles.text}>Cancel</Text>
        </Pressable>
        {request.method !== "approve" ? (
          <Pressable
            accessibilityRole="button"
            disabled={
              submitting ||
              (request.method === "select" && selected === null) ||
              !canAsk
            }
            onPress={() =>
              request.method === "formDialog"
                ? formSubmit.current?.()
                : submit()
            }
            style={[
              styles.primary,
              (submitting ||
                (request.method === "select" && selected === null) ||
                !canAsk) &&
                styles.disabled,
            ]}
          >
            <Text style={styles.primaryText}>
              {request.method === "confirm"
                ? "Confirm"
                : request.method === "select"
                  ? "Next"
                  : "Submit"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function ChatDialog({ request, ...props }: DialogProps) {
  return request ? (
    <DialogBody
      key={`${request.id}:${request.method}`}
      request={request}
      {...props}
    />
  ) : null;
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: theme.panel,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomColor: theme.border,
    borderBottomWidth: 1,
    gap: 3,
  },
  title: { color: theme.text, fontSize: 15, fontWeight: "600" },
  scroll: { maxHeight: 360 },
  body: { padding: 16, gap: 8 },
  text: { color: theme.text, fontSize: 14, lineHeight: 21 },
  dim: { color: theme.muted, fontSize: 12, lineHeight: 18 },
  monospace: {
    color: theme.muted,
    fontSize: 12,
    fontFamily: "Menlo",
    lineHeight: 18,
    padding: 8,
    backgroundColor: theme.hover,
    borderRadius: 8,
  },
  choice: {
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    gap: 3,
  },
  choiceSelected: { borderColor: theme.accent, backgroundColor: theme.hover },
  choiceText: { color: theme.text, fontSize: 14 },
  field: { gap: 6 },
  question: { gap: 7, marginBottom: 14 },
  input: {
    color: theme.text,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 40,
    fontSize: 14,
  },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  error: {
    color: DynamicColorIOS({ dark: "#ff7777", light: "#9E3434" }),
    fontSize: 13,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  button: { paddingHorizontal: 14, paddingVertical: 8 },
  primary: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: theme.accent,
    borderRadius: 7,
    alignSelf: "flex-end",
  },
  primaryText: {
    color: DynamicColorIOS({ dark: "#000000", light: "#FFFFFF" }),
    fontSize: 14,
    fontWeight: "600",
  },
  disabled: { opacity: 0.45 },
});
