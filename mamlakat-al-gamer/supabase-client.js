import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

export async function signInAdmin(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const user = data.user;
  const { data: role, error: roleError } = await supabase
    .from('user_roles').select('role').eq('user_id', user.id).maybeSingle();
  if (roleError || role?.role !== 'admin') {
    await supabase.auth.signOut();
    throw new Error('هذا الحساب ليس لديه صلاحية مدير.');
  }
  return user;
}

export async function requireAdmin() {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('يرجى تسجيل الدخول أولاً.');
  const { data, error: roleError } = await supabase
    .from('user_roles').select('role').eq('user_id', user.id).maybeSingle();
  if (roleError || data?.role !== 'admin') throw new Error('غير مصرح: صلاحية المدير مطلوبة.');
  return user;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

const safeName = name => String(name || 'file').normalize('NFKD')
  .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(-100);

async function upload(bucket, file, prefix) {
  if (!file) return null;
  const path = `${prefix}/${crypto.randomUUID()}-${safeName(file.name)}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    upsert: false, contentType: file.type || 'application/octet-stream'
  });
  if (error) throw error;
  return path;
}

export async function saveGame({ id, title, description, category, instructions, htmlFile, thumbnailFile, status = 'published' }) {
  await requireAdmin();
  if (!title?.trim()) throw new Error('اسم اللعبة مطلوب.');
  let html_file_path, thumbnail_path;
  if (htmlFile) html_file_path = await upload('game-files', htmlFile, 'games');
  if (thumbnailFile) thumbnail_path = await upload('game-thumbnails', thumbnailFile, 'games');
  const row = {
    title: title.trim(),
    description: description || '',
    category: category || 'ألعاب',
    instructions: instructions || '',
    status
  };
  if (html_file_path) row.html_file_path = html_file_path;
  if (thumbnail_path) row.thumbnail_path = thumbnail_path;

  let query = supabase.from('games');
  const result = id ? await query.update(row).eq('id', id).select().single()
                    : await query.insert(row).select().single();
  if (result.error) throw result.error;
  return result.data;
}

export async function listPublishedGames() {
  const { data, error } = await supabase.from('games')
    .select('id,title,description,category,instructions,html_file_path,thumbnail_path,status,created_at')
    .eq('status', 'published').order('created_at', { ascending: false });
  if (error) throw error;
  return Promise.all((data || []).map(async game => {
    const [thumb, html] = await Promise.all([
      game.thumbnail_path
        ? supabase.storage.from('game-thumbnails').getPublicUrl(game.thumbnail_path)
        : Promise.resolve({ data: { publicUrl: '' } }),
      game.html_file_path
        ? supabase.storage.from('game-files').createSignedUrl(game.html_file_path, 300)
        : Promise.resolve({ data: { signedUrl: '' }, error: null })
    ]);
    if (html.error) throw html.error;
    return { ...game, thumbnail_url: thumb.data.publicUrl, game_url: html.data.signedUrl };
  }));
}

export async function deleteGame(id) {
  await requireAdmin();
  const { data: game, error: readError } = await supabase.from('games')
    .select('html_file_path,thumbnail_path').eq('id', id).single();
  if (readError) throw readError;
  const { error } = await supabase.from('games').delete().eq('id', id);
  if (error) throw error;
  const removals = [];
  if (game.html_file_path) removals.push(supabase.storage.from('game-files').remove([game.html_file_path]));
  if (game.thumbnail_path) removals.push(supabase.storage.from('game-thumbnails').remove([game.thumbnail_path]));
  const results = await Promise.all(removals);
  const failed = results.find(x => x.error);
  if (failed) throw failed.error;
}
