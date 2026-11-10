import type { ComponentType, SVGProps } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
    Activity as ActivityGlyph,
    AlertCircle as AlertCircleGlyph,
    AlertTriangle as AlertTriangleGlyph,
    ArrowLeft as ArrowLeftGlyph,
    ArrowRight as ArrowRightGlyph,
    ArrowUp02Icon as ArrowUpGlyph,
    Bell as BellGlyph,
    BookOpen as BookOpenGlyph,
    Bot as BotGlyph,
    Boxes as BoxesGlyph,
    Brain as BrainGlyph,
    Camera as CameraGlyph,
    Check as CheckGlyph,
    CheckCircle as CheckCircleGlyph,
    ChevronDown as ChevronDownGlyph,
    ChevronLeft as ChevronLeftGlyph,
    ChevronRight as ChevronRightGlyph,
    Circle as CircleGlyph,
    CircleAlert as CircleAlertGlyph,
    Clock as ClockGlyph,
    Cloud as CloudGlyph,
    Code as CodeGlyph,
    Copy as CopyGlyph,
    Cpu as CpuGlyph,
    Database as DatabaseGlyph,
    Eraser as EraserGlyph,
    FilePenLineIcon as FilePenLineIconGlyph,
    FilePlus as FilePlusGlyph,
    FileText as FileTextGlyph,
    Flag as FlagGlyph,
    Folder as FolderGlyph,
    FolderPlus as FolderPlusGlyph,
    Footprints as FootprintsGlyph,
    Globe as GlobeGlyph,
    HardDrive as HardDriveGlyph,
    HelpCircleIcon as HelpCircleGlyph,
    Home as HomeGlyph,
    Hourglass as HourglassGlyph,
    Image as ImageGlyph,
    Info as InfoGlyph,
    Keyboard as KeyboardGlyph,
    LayoutGrid as LayoutGridGlyph,
    ListChecks as ListChecksGlyph,
    ListTodo as ListTodoGlyph,
    LoaderCircle as LoaderCircleGlyph,
    ListTree as ListTreeGlyph,
    MessageSquare as MessageSquareGlyph,
    Monitor as MonitorGlyph,
    Moon as MoonGlyph,
    MoreHorizontal as MoreHorizontalGlyph,
    MousePointer2 as MousePointer2Glyph,
    PackagePlus as PackagePlusGlyph,
    Palette as PaletteGlyph,
    PanelLeftClose as PanelLeftCloseGlyph,
    PanelLeftOpen as PanelLeftOpenGlyph,
    Pin as PinGlyph,
    Play as PlayGlyph,
    Plus as PlusGlyph,
    RefreshCw as RefreshCwGlyph,
    Save as SaveGlyph,
    Scissors as ScissorsGlyph,
    Search as SearchGlyph,
    Settings as SettingsGlyph,
    Settings2 as Settings2Glyph,
    RotateCcwIcon as RotateCcwGlyph,
    ShieldAlert as ShieldAlertGlyph,
    ShieldCheck as ShieldCheckGlyph,
    Sparkles as SparklesGlyph,
    Square as SquareGlyph,
    Sun as SunGlyph,
    Terminal as TerminalGlyph,
    Trash2 as Trash2Glyph,
    Upload as UploadGlyph,
    UserRound as UserRoundGlyph,
    Wifi as WifiGlyph,
    WifiOff as WifiOffGlyph,
    Wrench as WrenchGlyph,
    X as XGlyph,
} from '@hugeicons/core-free-icons';

/**
 * One icon set for the whole app: Hugeicons (free set) instead of Lucide.
 *
 * Every component keeps the name and the props the call sites already use (`size`, `className`,
 * `strokeWidth`, `aria-hidden`), so switching the set did not touch a single JSX attribute. That is
 * also why this file, and not the components, is the only place that knows which library is used.
 */
export type AppIconProps = SVGProps<SVGSVGElement> & {
    size?: number | string;
    strokeWidth?: number;
};

/** Lucide's type name is kept so existing annotations (`Record<string, LucideIcon>`) still compile. */
export type LucideIcon = ComponentType<AppIconProps>;

const icon =
    (glyph: Parameters<typeof HugeiconsIcon>[0]['icon']): LucideIcon =>
    ({ size = 24, className, strokeWidth = 1.5, ...rest }: AppIconProps) => (
        <HugeiconsIcon
            icon={glyph}
            size={size}
            strokeWidth={strokeWidth}
            className={className}
            {...(rest as Record<string, unknown>)}
        />
    );

export const Activity = icon(ActivityGlyph);
export const AlertCircle = icon(AlertCircleGlyph);
export const AlertTriangle = icon(AlertTriangleGlyph);
export const ArrowLeft = icon(ArrowLeftGlyph);
export const ArrowRight = icon(ArrowRightGlyph);
export const ArrowUp = icon(ArrowUpGlyph);
export const Bell = icon(BellGlyph);
export const BookOpen = icon(BookOpenGlyph);
export const Bot = icon(BotGlyph);
export const Boxes = icon(BoxesGlyph);
export const Brain = icon(BrainGlyph);
export const Camera = icon(CameraGlyph);
export const Check = icon(CheckGlyph);
export const CheckCircle = icon(CheckCircleGlyph);
export const ChevronDown = icon(ChevronDownGlyph);
export const ChevronLeft = icon(ChevronLeftGlyph);
export const ChevronRight = icon(ChevronRightGlyph);
export const Circle = icon(CircleGlyph);
export const CircleAlert = icon(CircleAlertGlyph);
export const Clock = icon(ClockGlyph);
export const Cloud = icon(CloudGlyph);
export const Code2 = icon(CodeGlyph);
export const Copy = icon(CopyGlyph);
export const Cpu = icon(CpuGlyph);
export const Database = icon(DatabaseGlyph);
export const Eraser = icon(EraserGlyph);
export const FilePenLine = icon(FilePenLineIconGlyph);
export const FilePlus2 = icon(FilePlusGlyph);
export const FileText = icon(FileTextGlyph);
export const Flag = icon(FlagGlyph);
export const Folder = icon(FolderGlyph);
export const FolderPlus = icon(FolderPlusGlyph);
export const Footprints = icon(FootprintsGlyph);
export const Globe = icon(GlobeGlyph);
export const HardDrive = icon(HardDriveGlyph);
export const HelpCircle = icon(HelpCircleGlyph);
export const Home = icon(HomeGlyph);
export const Hourglass = icon(HourglassGlyph);
export const Image = icon(ImageGlyph);
export const Info = icon(InfoGlyph);
export const Keyboard = icon(KeyboardGlyph);
export const LayoutGrid = icon(LayoutGridGlyph);
export const ListChecks = icon(ListChecksGlyph);
export const ListTree = icon(ListTreeGlyph);
export const ListTodo = icon(ListTodoGlyph);
export const Loader2 = icon(LoaderCircleGlyph);
export const MessageSquare = icon(MessageSquareGlyph);
export const Monitor = icon(MonitorGlyph);
export const Moon = icon(MoonGlyph);
export const MoreHorizontal = icon(MoreHorizontalGlyph);
export const MousePointer2 = icon(MousePointer2Glyph);
export const PackagePlus = icon(PackagePlusGlyph);
export const Palette = icon(PaletteGlyph);
export const PanelLeftClose = icon(PanelLeftCloseGlyph);
export const PanelLeftOpen = icon(PanelLeftOpenGlyph);
export const Pin = icon(PinGlyph);
export const Play = icon(PlayGlyph);
export const Plus = icon(PlusGlyph);
export const RefreshCw = icon(RefreshCwGlyph);
export const RotateCcw = icon(RotateCcwGlyph);
export const Save = icon(SaveGlyph);
export const Scissors = icon(ScissorsGlyph);
export const Search = icon(SearchGlyph);
export const Settings = icon(SettingsGlyph);
export const Settings2 = icon(Settings2Glyph);
export const ShieldAlert = icon(ShieldAlertGlyph);
export const ShieldCheck = icon(ShieldCheckGlyph);
export const Sparkles = icon(SparklesGlyph);
export const Square = icon(SquareGlyph);
export const Sun = icon(SunGlyph);
export const Terminal = icon(TerminalGlyph);
export const Trash2 = icon(Trash2Glyph);
export const Upload = icon(UploadGlyph);
export const UserRound = icon(UserRoundGlyph);
export const Wifi = icon(WifiGlyph);
export const WifiOff = icon(WifiOffGlyph);
export const Wrench = icon(WrenchGlyph);
export const X = icon(XGlyph);

/** Lucide has `CheckCircle2`; both names map to the same Hugeicons glyph. */
export const CheckCircle2 = icon(CheckCircleGlyph);
/** Lucide's `TriangleAlert` is the same glyph as `AlertTriangle`. */
export const TriangleAlert = icon(AlertTriangleGlyph);
