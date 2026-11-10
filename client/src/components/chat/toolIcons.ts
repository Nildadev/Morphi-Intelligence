import {
    Activity,
    BookOpen,
    Bot,
    Boxes,
    Camera,
    Cloud,
    Code2,
    FilePenLine,
    FilePlus2,
    FileText,
    Footprints,
    Globe,
    Hourglass,
    Image,
    Keyboard,
    LayoutGrid,
    ListTodo,
    Monitor,
    MousePointer2,
    PackagePlus,
    Palette,
    Play,
    Save,
    Scissors,
    Search,
    Sparkles,
    Terminal,
    Trash2,
    Upload,
    UserRound,
    Wrench,
    type LucideIcon,
} from '../icons';

/**
 * Task 31C — icons live in their own module so `ToolCallCard.tsx` keeps exporting only components
 * (the fast-refresh rule counts every extra export).
 */
export const TOOL_ICONS: Record<string, LucideIcon> = {
    run_command: Terminal,
    execute_luau: Code2,
    read_file: FileText,
    write_file: FilePenLine,
    edit_script_lines: FilePenLine,
    insert_script_lines: FilePenLine,
    set_script_source: FilePenLine,
    search_web: Globe,
    search_objects: Search,
    delete_object: Trash2,
    todo_write: ListTodo,
};

/**
 * Task 31C — the 35 Studio tools, keyed by their SERVER name (the part after `studio.`). The icon
 * says what the tool does, so a card is recognisable before reading its title: a camera for a
 * capture, a keyboard for input, scissors for a mesh split.
 */
export const STUDIO_ICONS: Record<string, LucideIcon> = {
  // Read-only inspection.
  list_roblox_studios: Monitor,
  get_studio_state: Activity,
  get_console_output: Terminal,
  inspect_instance: Boxes,
  search_game_tree: LayoutGrid,
  script_read: FileText,
  script_search: Search,
  script_grep: Search,
  search_asset: Image,
  screen_capture: Camera,
  http_get: Globe,
  skill: BookOpen,
  list_skills: BookOpen,
  wait_job_finished: Hourglass,
  // Mutating the place.
  execute_luau: Code2,
  multi_edit: FilePenLine,
  insert_asset: PackagePlus,
  start_stop_play: Play,
  character_navigation: Footprints,
  user_mouse_input: MousePointer2,
  user_keyboard_input: Keyboard,
  auto_setup_avatar: UserRound,
  subagent: Bot,
  create_skill: FilePlus2,
  edit_skill: FilePenLine,
  // Costly or publishing.
  upload_image: Upload,
  store_image: Save,
  generate_avatar: UserRound,
  generate_material: Palette,
  generate_mesh: Boxes,
  generate_procedural_model: Boxes,
  generate_scene: LayoutGrid,
  generate_texture: Sparkles,
  segment_mesh: Scissors,
  open_cloud_invoke: Cloud,
};

/** Built-in map first, then the Studio map by server name, then a neutral wrench. */
export const toolIcon = (name: string): LucideIcon =>
    TOOL_ICONS[name]
    ?? STUDIO_ICONS[name.startsWith('studio.') ? name.slice('studio.'.length) : name]
    ?? Wrench;
