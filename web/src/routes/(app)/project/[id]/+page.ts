import { redirect } from "@sveltejs/kit";

export const load = ({ params }: { params: { id: string } }) => {
	throw redirect(307, `/project/${params.id}/chat`);
};
