import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockNode, Entry, SaveState } from "@docleus/sdk";
import { api } from "../lib/api.ts";
import type { EditBranchGate } from "../lib/edit-branch.ts";
import { asComponent, useSlot } from "../lib/host.tsx";
import { withBranch } from "../lib/router.ts";
import { useLoad } from "../lib/use-load.ts";
import { ErrorView } from "./error-view.tsx";

function plainText(block: BlockNode): string[] {
  const own = (block.inline ?? []).map((node) => node.text ?? "").join("");
  return [...(own ? [own] : []), ...(block.content ?? []).flatMap(plainText)];
}

/** Without an editor plugin the page is shown as plain text. */
function ReadOnlyBody(props: { body: BlockNode }) {
  return (
    <div className="read-only">
      <p className="notice">No editor plugin is enabled in this space.</p>
      {plainText(props.body).map((text, i) => (
        <p key={i}>{text}</p>
      ))}
    </div>
  );
}

interface LoadedHead {
  readonly key: string;
  readonly head: string | null;
}

interface Seed {
  readonly key: string;
  /** Changes whenever the editor must start over from the loaded body. */
  readonly generation: number;
}

const headKey = (branch: string, pageId: string) => `${branch}\n${pageId}`;

/** The page title: plain text, editable in edit mode, saved on Enter or blur. */
function Title(props: {
  title: string;
  isEditing: boolean;
  /** A page just created: its title is focused and selected, ready to type over. */
  isNew: boolean;
  onRename(title: string): void;
}) {
  const element = useRef<HTMLHeadingElement>(null);
  const shown = useRef(props.title);
  useEffect(() => {
    const heading = element.current;
    if (!heading) return;
    if (document.activeElement !== heading || !props.isEditing) {
      heading.textContent = props.title;
      shown.current = props.title;
    }
  }, [props.title, props.isEditing]);
  const { isEditing, isNew } = props;
  useEffect(() => {
    const heading = element.current;
    if (!heading || !isEditing || !isNew) return;
    heading.focus();
    getSelection()?.selectAllChildren(heading);
  }, [isEditing, isNew]);
  const commit = () => {
    const text = (element.current?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (text !== shown.current) {
      shown.current = text;
      props.onRename(text);
    }
  };
  return (
    <h1
      ref={element}
      className="title"
      contentEditable={props.isEditing ? "plaintext-only" : false}
      suppressContentEditableWarning
      data-placeholder="Untitled"
      onBlur={props.isEditing ? commit : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        commit();
        const body = element.current
          ?.closest("article")
          ?.querySelector<HTMLElement>('[contenteditable="true"]:not(.title)');
        body?.focus();
      }}
    />
  );
}

export function PageView(props: {
  orgId: string;
  spaceId: string;
  pageId: string;
  title: string;
  canWrite: boolean;
  isEditing: boolean;
  branch: string;
  openBranch(name: string): void;
  gate: EditBranchGate;
  isNew: boolean;
  onSaveState(state: SaveState): void;
  onRename(title: string): void;
}) {
  const { orgId, spaceId, pageId, branch, openBranch, gate } = props;
  const path = `/api/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}`;
  const key = headKey(branch, pageId);
  const page = useLoad(key, async () => ({
    key,
    ...(await api<{ page: Entry; head: string | null }>(
      "GET",
      withBranch(path, branch),
    )),
  }));
  // The head the next body save is based on.
  const head = useRef<LoadedHead | undefined>(undefined);
  // Set when a save moved the page to the edit branch: switching the view
  // there keeps the editor, which already holds the saved document.
  const movedTo = useRef<string | undefined>(undefined);

  const [seed, setSeed] = useState<Seed>({ key, generation: 0 });
  const isMoved = movedTo.current === key;
  if (seed.key !== key) {
    setSeed({
      key,
      generation: isMoved ? seed.generation : seed.generation + 1,
    });
  }
  useEffect(() => {
    if (movedTo.current !== seed.key) movedTo.current = undefined;
  }, [seed]);
  useEffect(() => {
    // The head a moving save got back is newer than the branch's reload.
    if (page.data && head.current?.key !== page.data.key) {
      head.current = { key: page.data.key, head: page.data.head };
    }
  }, [page.data]);

  const save = useCallback(
    (document: unknown) =>
      gate.write(pageId, async (target) => {
        const result = await api<{ head: string }>(
          "PUT",
          withBranch(`${path}/body`, target),
          { base: head.current?.head ?? null, document },
        );
        const savedKey = headKey(target, pageId);
        if (head.current?.key !== savedKey) movedTo.current = savedKey;
        head.current = { key: savedKey, head: result.head };
      }),
    [gate, path, pageId],
  );

  const editors = useSlot("page.editor");
  const headers = useSlot("page.header");
  const footers = useSlot("page.footer");
  const slotProps = { orgId, spaceId, entryId: pageId, branch, openBranch };

  if (page.error !== undefined) return <ErrorView error={page.error} />;
  const data = page.data;
  const isShown =
    data !== undefined &&
    (data.key === key || (isMoved && data.page.id === pageId));
  if (!isShown) return null;
  const { body } = data.page;
  if (!body) return null;
  const editor = editors[0];
  const Editor = editor && asComponent(editor.component);

  return (
    <article className="page doc">
      {headers.length > 0 && (
        <div className="page-head">
          {headers.map((item) => {
            const Header = asComponent(item.component);
            return <Header key={item.id} {...slotProps} />;
          })}
        </div>
      )}
      <Title
        title={props.title}
        isEditing={props.isEditing && props.canWrite}
        isNew={props.isNew}
        onRename={props.onRename}
      />
      <div className="body">
        {Editor ? (
          <Editor
            key={`${pageId}#${seed.generation}`}
            orgId={orgId}
            spaceId={spaceId}
            entryId={pageId}
            branch={branch}
            body={body}
            save={save}
            isEditable={props.isEditing && props.canWrite}
            onSaveState={props.onSaveState}
          />
        ) : (
          <ReadOnlyBody body={body} />
        )}
      </div>
      {footers.map((item) => {
        const Footer = asComponent(item.component);
        return <Footer key={item.id} {...slotProps} />;
      })}
    </article>
  );
}
